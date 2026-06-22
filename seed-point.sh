#!/usr/bin/env bash
set -euo pipefail
BASE=http://127.0.0.1:3010/api/v1
LOGIN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@visionyx.lat","password":"VisionyxDemo2026!"}')
echo "login: $(echo "$LOGIN" | head -c 120)"
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("token") or d.get("accessToken") or d.get("access_token") or "")')
if [ -z "$TOKEN" ]; then echo "SIN TOKEN"; exit 1; fi
echo "token OK (len ${#TOKEN})"
COUNT=$(curl -s $BASE/access/points -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json
try:
  print(len(json.load(sys.stdin)))
except Exception:
  print(0)')
echo "puntos existentes: $COUNT"
if [ "$COUNT" = "0" ]; then
  echo "creando punto de demo..."
  curl -s -X POST $BASE/access/points -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"name":"Puerta de demostración","controllerKind":"SIMULATED","matchThreshold":0.45,"livenessThreshold":0.5}' | head -c 300
  echo
fi
echo "--- puntos ---"
curl -s $BASE/access/points -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
