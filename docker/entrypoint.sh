#!/bin/sh
# Zom's HaRM container start-up: make sure HTTPS is ready, then run the server.
#   HARM_CERT_NAMES  names/IPs phones use to reach this server, e.g. "192.168.1.50 harm.lan"
#   HARM_TLS=0       serve plain HTTP (only behind your own HTTPS reverse proxy)
set -e
DATA="$(dirname "${HARM_DB:-/data/harm.db}")"
# Started as root (the default): make the data folder writable for the harm user, then drop to it.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ "$(stat -c %u "$DATA")" != "$(id -u harm)" ]; then chown -R harm:harm "$DATA"; fi
  exec setpriv --reuid=harm --regid=harm --init-groups "$0" "$@"
fi
PORT="${HARM_PORT:-8077}"
if [ "${HARM_TLS:-1}" = "1" ]; then
  if [ -z "${HARM_CERT_NAMES:-}" ]; then
    echo "note: HARM_CERT_NAMES is not set. Phones need the server's LAN IP or hostname in the certificate;" >&2
    echo "      set it in docker-compose.yml (e.g. HARM_CERT_NAMES: \"192.168.1.50 harm.lan\") and restart." >&2
  fi
  # shellcheck disable=SC2086
  python -m harm.certs --ensure ${HARM_CERT_NAMES:-localhost}
  set -- --ssl-certfile "$DATA/tls/harm.crt" --ssl-keyfile "$DATA/tls/harm.key" "$@"
fi
exec uvicorn harm.main:app --host 0.0.0.0 --port "$PORT" --proxy-headers \
  --forwarded-allow-ips "${HARM_TRUSTED_PROXIES:-127.0.0.1}" --no-server-header "$@"
