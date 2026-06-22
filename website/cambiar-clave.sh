#!/usr/bin/env bash
# ============================================================
#  Visionyx · Cambio interactivo de contraseña de correo
#  Uso:  bash ~/cambiar-clave.sh
# ============================================================
set -uo pipefail

CONTAINER="mailserver"

echo "==============================================="
echo "   Visionyx · Cambiar contrasena de correo"
echo "==============================================="
echo

# 1. Verificar que el servidor de correo este corriendo
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: el contenedor '$CONTAINER' no esta corriendo."
  exit 1
fi

# 2. Mostrar buzones existentes
echo "Buzones existentes:"
docker exec "$CONTAINER" setup email list 2>/dev/null | grep '@' | sed 's/^/   - /'
echo

# 3. Pedir el correo
read -rp "Escribe el correo a modificar: " EMAIL
if [ -z "${EMAIL}" ]; then
  echo "No escribiste nada. Cancelado."
  exit 1
fi

# 4. Confirmar que existe
if ! docker exec "$CONTAINER" setup email list 2>/dev/null | grep -q "$EMAIL"; then
  read -rp "AVISO: '$EMAIL' no aparece en la lista. Continuar igual? (s/n): " ANS
  [ "$ANS" = "s" ] || { echo "Cancelado."; exit 1; }
fi

# 5. Pedir contrasena (oculta) dos veces, con validacion
while true; do
  read -rsp "Nueva contrasena (min 8): " P1; echo
  read -rsp "Repite la contrasena:      " P2; echo
  if [ "$P1" != "$P2" ]; then
    echo "  -> No coinciden. Intenta de nuevo."
    echo
    continue
  fi
  if [ "${#P1}" -lt 8 ]; then
    echo "  -> Muy corta (minimo 8 caracteres). Intenta de nuevo."
    echo
    continue
  fi
  break
done

# 6. Aplicar el cambio
if docker exec "$CONTAINER" setup email update "$EMAIL" "$P1" >/dev/null 2>&1; then
  echo
  echo "Contrasena actualizada para $EMAIL."
else
  echo "ERROR: no se pudo actualizar. Revisa el correo escrito."
  exit 1
fi

# 7. Verificar que el login funciona
if docker exec "$CONTAINER" doveadm auth test "$EMAIL" "$P1" >/dev/null 2>&1; then
  echo "Verificado: el login funciona con la nueva contrasena."
else
  echo "ATENCION: el cambio se aplico pero no se pudo verificar el login."
fi

echo
echo "Listo. Entra en https://mail.visionyx.lat"
