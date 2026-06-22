#!/usr/bin/env bash
# nginx + certificado para el demo público de VISIONYX Access.
set -euo pipefail
DOMAIN=demo.visionyx.lat

# 1) Bloque HTTP-only para el reto ACME.
sudo tee /etc/nginx/sites-available/demo-access.conf >/dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://${DOMAIN}\$request_uri; }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/demo-access.conf /etc/nginx/sites-enabled/demo-access.conf
sudo nginx -t && sudo systemctl reload nginx

# 2) Certificado Let's Encrypt.
sudo certbot certonly --webroot -w /var/www/html -d ${DOMAIN} \
  --non-interactive --agree-tos -m contacto@visionyx.lat --no-eff-email

# 3) Config final: HTTPS + proxy al backend (loopback). Cuerpo grande para
#    los frames de webcam (base64) del kiosko.
sudo tee /etc/nginx/sites-available/demo-access.conf >/dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://${DOMAIN}\$request_uri; }
}
server {
    listen 443 ssl;
    server_name ${DOMAIN};
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    client_max_body_size 16m;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
NGINX
sudo nginx -t && sudo systemctl reload nginx
echo "NGINX+CERT OK para ${DOMAIN}"
