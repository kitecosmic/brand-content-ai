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

docker compose up -d --build
echo
docker compose ps
echo
echo "logs:   docker compose logs -f"
echo "estado: docker compose exec -u node panel node --disable-warning=ExperimentalWarning src/cli.mjs doctor"
