/**
 * Tipos compartidos para la **memoria entre consultas** del Copiloto.
 *
 * Hasta ahora el copiloto no retenía el estado del sistema entre turnos: al
 * preguntar "¿hay novedades desde la última consulta?" no había nada con lo que
 * comparar, así que el modelo respondía "no puedo saberlo" (con razón). Estos
 * tipos definen un *snapshot* persistido por conversación y un contexto que se
 * inyecta en cada tool, de modo que la tool `novedades` pueda calcular el diff
 * contra el snapshot anterior y la capa de análisis opere sobre datos reales.
 */

/**
 * Fotografía del estado del sistema tomada al cierre de un turno del copiloto.
 * Se persiste en `copilot_conversation.state_snapshot` (JSONB). Es delibera-
 * damente compacta: lo justo para detectar cambios y deltas, no un volcado.
 *
 * - `eventos.total` es un conteo de hoy (no histórico); sirve de huella para
 *   detectar que creció, pero el diff real se hace por `ultimoEventoEn`.
 * - `ultimoEventoEn` es el timestamp del evento más reciente visto en el turno;
 *   el diff de la siguiente consulta busca eventos con `recordedAt > este`.
 */
export interface ConversationSnapshot {
  /** Momento (ISO) en que se capturó este snapshot (= cierre del turno). */
  capturadoEn: string;
  eventos: {
    /** Conteo de eventos de hoy en el momento del snapshot (huella). */
    total: number;
    granted: number;
    denied: number;
  };
  /** Timestamp ISO del evento más reciente; pivote del diff temporal. */
  ultimoEventoEn: string | null;
  empleados: {
    total: number;
    activos: number;
    conBiometria: number;
  };
}

/**
 * Contexto que el bucle agéntico inyecta en cada ejecución de tool. Reemplaza
 * al `userId` suelto que antes recibían las tools de acción y permite a las de
 * sistema acceder al snapshot previo de la conversación.
 */
export interface ToolContext {
  /** Admin que dispara el turno (atribución de acciones). */
  userId: string;
  /** Conversación activa (para, p. ej., auditar por hilo). */
  conversationId: string;
  /** Snapshot guardado al cierre del turno anterior, o `null` si no hay. */
  prevSnapshot: ConversationSnapshot | null;
}
