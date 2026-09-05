#!/bin/sh
# Render the nginx.conf from the template, substituting the Runtime env vars
# (only these two — every other $var in the template is nginx's own), then exec
# the real command (nginx). Preserves `docker run ... CMD` overrides.
set -euo pipefail

# Point the image straight at the hermes config/gateway from the repo's .env:
# mount the repo's <repo>/apps/web-desktop/.env -> /app/.env (read-only) and it
# supplies HERMES_GATEWAY_URL / HERMES_HOME (and HERMES_WEB_URL for reference).
# Values set with -e / --env-file always win over the mounted .env.
if [ -r /app/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /app/.env
  set +a
fi

: "${HERMES_GATEWAY_URL:=http://127.0.0.1:9119}"
: "${HERMES_HOME:=/data/hermes}"

# So nginx's autoindex .listing endpoints (nginx.conf.template) see a real,
# empty directory instead of 404ing when the plugin dirs haven't been created
# yet on a fresh mount. Best-effort: don't fail startup on a read-only mount.
mkdir -p "${HERMES_HOME}/plugins" "${HERMES_HOME}/desktop-plugins" 2>/dev/null || true

[ -f /etc/nginx/nginx.conf ] || cp /etc/nginx/nginx.conf.template /etc/nginx/nginx.conf

envsubst '$HERMES_GATEWAY_URL $HERMES_HOME' \
    < /etc/nginx/nginx.conf \
    > /etc/nginx/nginx.conf.rendered

mv /etc/nginx/nginx.conf.rendered /etc/nginx/nginx.conf

exec "$@"