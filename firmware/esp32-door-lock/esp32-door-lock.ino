/*
 * Office Access Control — Controlador físico de puerta (ESP32 + relé + maglock).
 * ---------------------------------------------------------------------------
 * Implementa la máquina de estados de la cerradura LOCALMENTE (no depende del
 * backend para re-bloquear → fail-secure local). El backend solo emite el PULSO
 * de apertura cuando el Face ID autoriza:  GET /open?token=...
 *
 *   Arranque               -> maglock ENERGIZADO (BLOQUEADO)
 *   GET /open (token ok)   -> maglock OFF (LIBRE) + arranca temporizador
 *   Sensor: abrió y cerró  -> CLOSED estable RELOCK_DELAY_MS -> re-BLOQUEA
 *   Timeout sin apertura   -> re-BLOQUEA igual (UNLOCK_TIMEOUT_MS)
 *   Corte de energía       -> maglock OFF (puerta libre = egreso garantizado)
 *
 * ⚠ SEGURIDAD DE EVACUACIÓN: esta puerta es ruta de evacuación. Usa un MAGLOCK
 *   FAIL-SAFE (energizado = bloqueado; sin energía = abierto). El cableado debe
 *   garantizar que la salida desde el interior sea SIEMPRE libre (barra de
 *   egreso / botón REX en serie que corte el maglock) y que la central de
 *   incendios pueda cortar el maglock. El Face ID controla SOLO la entrada.
 *
 * Cableado del relé (fail-safe):
 *   12V+ --> [COM relé]    [NO relé] --> Maglock+      Maglock- --> 12V-
 *   Relé ON  (RELAY_ACTIVE) cierra COM-NO  -> maglock con corriente = BLOQUEADO
 *   Relé OFF                abre  COM-NO    -> maglock sin corriente = LIBRE
 *   (Si tu módulo de relé es activo-bajo, ajusta RELAY_ACTIVE_HIGH = false.)
 *
 * Hardware sugerido: Olimex ESP32-POE-ISO (PoE) o LILYGO T-ETH-Lite, módulo de
 * relé 1 canal optoacoplado, sensor magnético NC (reed) en el canto de cierre.
 * Para la variante Ethernet, sustituir WiFi.* por ETH.* (ver notas al final).
 */

#include <WiFi.h>
#include <WebServer.h>

// ── Configuración (ajustar antes de flashear) ──────────────────────────────
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD";

// Token compartido con el backend (controllerRef = http://<ip>/open?token=ESTE).
// NO lo dejes en blanco en producción.
const char* OPEN_TOKEN = "cambia-este-token-largo-y-secreto";

// Pines (ajustar a tu placa).
const int PIN_RELAY  = 16;   // Salida al módulo de relé que alimenta el maglock.
const int PIN_SENSOR = 17;   // Entrada del sensor magnético (reed) de puerta.

// Lógica del relé: true = activo-alto (ON con HIGH). Muchos módulos chinos son
// activo-bajo: en ese caso poner false.
const bool RELAY_ACTIVE_HIGH = true;

// Lógica del sensor: con reed NC + INPUT_PULLUP, puerta CERRADA = LOW.
// Si tu sensor es NO o el cableado se invierte, cambia este flag.
const bool SENSOR_CLOSED_IS_LOW = true;

// Tiempos.
const unsigned long UNLOCK_TIMEOUT_MS = 8000;  // máx. tiempo liberado sin abrir.
const unsigned long RELOCK_DELAY_MS   = 2000;  // espera tras cerrar antes de bloquear.
const unsigned long SENSOR_DEBOUNCE_MS = 80;

// ── Estado interno ──────────────────────────────────────────────────────────
WebServer server(80);

enum LockState { LOCKED, UNLOCKED };
LockState lockState = LOCKED;

unsigned long unlockedAt = 0;     // cuándo se liberó la puerta.
bool doorWasOpened = false;       // ¿se llegó a abrir tras liberar?
unsigned long closedSince = 0;    // desde cuándo está cerrada (para re-bloqueo).

// ── Helpers de hardware ─────────────────────────────────────────────────────
void applyRelay(bool energizeMaglock) {
  // energizeMaglock=true -> maglock con corriente -> BLOQUEADO.
  bool level = energizeMaglock ? RELAY_ACTIVE_HIGH : !RELAY_ACTIVE_HIGH;
  digitalWrite(PIN_RELAY, level ? HIGH : LOW);
}

void lockDoor() {
  applyRelay(true);
  lockState = LOCKED;
  doorWasOpened = false;
  Serial.println("[lock] BLOQUEADO");
}

void unlockDoor() {
  applyRelay(false);
  lockState = UNLOCKED;
  unlockedAt = millis();
  doorWasOpened = false;
  Serial.println("[lock] LIBERADO (Face ID)");
}

bool doorIsClosed() {
  int raw = digitalRead(PIN_SENSOR);
  bool isLow = (raw == LOW);
  return SENSOR_CLOSED_IS_LOW ? isLow : !isLow;
}

// ── Endpoints HTTP ──────────────────────────────────────────────────────────
void handleOpen() {
  if (!server.hasArg("token") || String(OPEN_TOKEN) != server.arg("token")) {
    server.send(403, "application/json", "{\"ok\":false,\"error\":\"forbidden\"}");
    return;
  }
  unlockDoor();
  server.send(200, "application/json", "{\"ok\":true,\"state\":\"unlocked\"}");
}

void handleStatus() {
  String body = String("{\"state\":\"") + (lockState == LOCKED ? "locked" : "unlocked") +
                "\",\"doorClosed\":" + (doorIsClosed() ? "true" : "false") + "}";
  server.send(200, "application/json", body);
}

void handleNotFound() {
  server.send(404, "application/json", "{\"ok\":false,\"error\":\"not_found\"}");
}

// ── Máquina de estados de re-bloqueo (no bloqueante) ────────────────────────
void updateLockStateMachine() {
  if (lockState != UNLOCKED) return;

  static bool lastClosed = true;
  static unsigned long lastChange = 0;
  bool closedNow = doorIsClosed();

  // Debounce del sensor.
  if (closedNow != lastClosed && (millis() - lastChange) > SENSOR_DEBOUNCE_MS) {
    lastClosed = closedNow;
    lastChange = millis();
    if (!closedNow) {
      doorWasOpened = true;       // la persona abrió la hoja.
      closedSince = 0;
      Serial.println("[door] ABIERTA");
    } else {
      closedSince = millis();     // volvió a cerrar.
      Serial.println("[door] CERRADA");
    }
  }

  // 1) Se abrió y volvió a cerrar de forma estable -> re-bloquear.
  if (doorWasOpened && closedNow && closedSince > 0 &&
      (millis() - closedSince) >= RELOCK_DELAY_MS) {
    lockDoor();
    return;
  }

  // 2) Timeout: nadie pasó tras liberar -> re-bloquear para no quedar abierto.
  if ((millis() - unlockedAt) >= UNLOCK_TIMEOUT_MS) {
    Serial.println("[lock] timeout sin apertura");
    lockDoor();
  }
}

// ── Setup / loop ────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_SENSOR, INPUT_PULLUP);

  // Fail-secure al arrancar: la puerta queda bloqueada.
  lockDoor();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\nWiFi OK. IP: %s\n", WiFi.localIP().toString().c_str());

  server.on("/open", HTTP_GET, handleOpen);
  server.on("/status", HTTP_GET, handleStatus);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server en :80  (controllerRef = http://<ip>/open?token=...)");
}

void loop() {
  server.handleClient();
  updateLockStateMachine();
}

/*
 * Variante Ethernet (Olimex ESP32-POE-ISO / LILYGO T-ETH-Lite):
 *   #include <ETH.h>
 *   - Sustituir WiFi.begin(...) por ETH.begin(...) con la config del PHY de la
 *     placa (LAN8720). Mantener el resto idéntico.
 *   - PoE alimenta la placa; el maglock va por su fuente 12V dedicada
 *     (MeanWell), NO desde el ESP32.
 */
