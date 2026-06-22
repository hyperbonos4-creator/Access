#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Configura el servidor Oracle como "puerta pública" segura de la cámara.
#
#   Celular ─HTTPS+login─> nginx (Oracle) ─proxy─> 127.0.0.1:8081 ─túnel SSH─>
#   ─> backend local ─> cámara Hikvision
#
# Requisitos ANTES de correr esto:
#   1) En la consola de Oracle Cloud: VCN > Security List (o NSG) de la subred,
#      agrega reglas de INGRESS: TCP 80 y TCP 443 desde 0.0.0.0/0.
#   2) El túnel local debe estar activo (tunnel.ps1) para que /cam muestre video.
#
# Uso (en el Oracle, como ubuntu):
#   chmod +x oracle-cam-setup.sh
#   sudo ./oracle-cam-setup.sh "EL_SECRETO_FAMILY" "usuario_login" "clave_login"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SECRET="${1:?Falta el FAMILY_STREAM_SECRET como 1er argumento}"
AUTH_USER="${2:?Falta el usuario de login como 2do argumento}"
AUTH_PASS="${3:?Falta la clave de login como 3er argumento}"

PUBLIC_IP="$(curl -s ifconfig.me || echo '157.137.230.190')"
HOST="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"   # ej. 157-137-230-190.sslip.io
TUNNEL_PORT=8081

echo "==> Dominio sin comprar nada: $HOST"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx apache2-utils certbot python3-certbot-nginx

# Firewall del SO (además de la Security List de Oracle Cloud).
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi
# Las imágenes Ubuntu de Oracle traen iptables restrictivo (REJECT al final):
# insertamos ACCEPT para 80/443 al INICIO para que queden antes del REJECT.
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
(netfilter-persistent save || iptables-save > /etc/iptables/rules.v4) 2>/dev/null || true

# Login (Basic Auth) de nginx.
htpasswd -bc /etc/nginx/.cam_htpasswd "$AUTH_USER" "$AUTH_PASS"

# Config temporal (HTTP) para el reto de Let's Encrypt.
cat >/etc/nginx/sites-available/cam.conf <<NGINX
server {
    listen 80;
    server_name $HOST;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 'ok'; }
}
NGINX
ln -sf /etc/nginx/sites-available/cam.conf /etc/nginx/sites-enabled/cam.conf
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/html
nginx -t && systemctl reload nginx

# Certificado HTTPS: intenta Let's Encrypt (válido); si falla (puertos 80/443
# cerrados en la Security List de Oracle), cae a autofirmado para no quedar a medias.
CRT=""; KEY=""
if certbot certonly --webroot -w /var/www/html -d "$HOST" \
     --non-interactive --agree-tos -m "admin@$HOST" --no-eff-email; then
  CRT="/etc/letsencrypt/live/$HOST/fullchain.pem"
  KEY="/etc/letsencrypt/live/$HOST/privkey.pem"
  echo "==> Certificado Let's Encrypt VÁLIDO emitido para $HOST"
else
  echo "!! Let's Encrypt falló (probable: faltan reglas Ingress 80/443 en Oracle)."
  echo "!! Uso certificado AUTOFIRMADO (el móvil mostrará una advertencia una vez)."
  mkdir -p /etc/nginx/ssl
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/nginx/ssl/cam.key -out /etc/nginx/ssl/cam.crt -subj "/CN=$HOST"
  CRT="/etc/nginx/ssl/cam.crt"
  KEY="/etc/nginx/ssl/cam.key"
fi

# Config final: HTTPS + login + proxy SOLO a la vista de cámara.
cat >/etc/nginx/sites-available/cam.conf <<NGINX
server {
    listen 80;
    server_name $HOST;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $HOST;

    ssl_certificate     $CRT;
    ssl_certificate_key $KEY;

    auth_basic           "Camara URBAN";
    auth_basic_user_file /etc/nginx/.cam_htpasswd;

    # Enlace corto para el celular: /cam
    location = /cam { return 302 /api/v1/family/view?k=$SECRET; }

    # Solo la vista de cámara se expone; el resto del backend NO.
    location /api/v1/family/ {
        proxy_pass http://127.0.0.1:$TUNNEL_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;          # imprescindible para MJPEG en vivo
        proxy_read_timeout 3600s;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
    location / { return 404; }
}
NGINX
nginx -t && systemctl reload nginx

echo ""
echo "============================================================"
echo " LISTO. Abre en el celular (con el túnel activo en el PC):"
echo "   https://$HOST/cam"
echo " Te pedirá usuario/clave: $AUTH_USER / (la que pusiste)"
echo "============================================================"
