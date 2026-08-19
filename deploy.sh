#!/usr/bin/env sh
#
# Redeploy: `git pull && ./deploy.sh`.
#
# El pull queda afuera a proposito. Si este script se actualizara a si mismo
# mientras corre, sh podria seguir leyendo el archivo viejo desde el offset
# donde iba y ejecutar una mezcla de las dos versiones.
set -eu

cd "$(dirname "$0")"

# El compose necesita el archivo si o si; que exista vacio esta bien, porque los
# secretos tambien se pueden cargar desde el panel (tab Ajustes) y esos mandan.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "no habia .env: se creo uno desde la plantilla."
  echo "completalo con 'nano .env' o carga todo despues desde el panel (tab Ajustes)."
  echo
fi

# Los volumenes son carpetas del host. Crearlas aca es una comodidad para verlas
# en el repo desde el primer dia; el dueno lo arregla el entrypoint al arrancar,
# corras esto como root o como vos.
mkdir -p data content projects

# --- dominio -----------------------------------------------------------------
#
# Con PANEL_DOMINIO en el .env se suma Caddy, que publica el panel en ese dominio
# con HTTPS. Sin el, no. El perfil de compose se maneja solo: se escribe
# COMPOSE_PROFILES en el .env para que TODOS los comandos de docker compose
# —logs, restart, ps— vean a Caddy sin tener que acordarse de ningun flag.
dominio=$(sed -n 's/^[[:space:]]*PANEL_DOMINIO[[:space:]]*=//p' .env | tail -1 | sed 's/[" ]//g' | sed "s/'//g")

if [ -n "$dominio" ]; then
  if ! grep -qE '^COMPOSE_PROFILES=.*dominio' .env; then
    printf '\n# Escrito por deploy.sh: hace que docker compose vea el servicio caddy.\nCOMPOSE_PROFILES=dominio\n' >> .env
    echo "se activo el perfil del dominio en el .env"
  fi
  echo "dominio: $dominio"
  echo "  Caddy pide el certificado la primera vez que alguien entra."
  echo "  Antes de eso, el DNS de $dominio tiene que apuntar a este servidor."
  echo
elif grep -qE '^COMPOSE_PROFILES=.*dominio' .env; then
  # Saco el dominio del .env: hay que bajar el proxy, no dejarlo ocupando el 443.
  docker compose --profile dominio rm -sf caddy >/dev/null 2>&1 || true
  sed -i '/^COMPOSE_PROFILES=/d; /^# Escrito por deploy.sh/d' .env
  echo "sin PANEL_DOMINIO: se bajo Caddy — el panel queda solo en 127.0.0.1:4317"
  echo
fi

docker compose up -d --build
echo
docker compose ps
echo
echo "logs:   docker compose logs -f"
echo "estado: docker compose exec -u node panel node --disable-warning=ExperimentalWarning src/cli.mjs doctor"
if [ -n "$dominio" ]; then
  echo "panel:  https://$dominio"
fi
