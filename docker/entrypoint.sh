#!/bin/sh
#
# Arranque del contenedor: deja los volumenes escribibles y baja privilegios.
#
# Los tres volumenes son carpetas del host y llegan con el dueno que tengan alla
# — root, si las creo Docker o si desplegas desde una sesion de root. Adentro el
# proceso corre como `node` (uid 1000), porque un Chrome que abre HTML escrito
# por un modelo no tiene por que ser root; sin este ajuste no podria escribir ni
# la base y el contenedor moriria en el arranque con un EACCES.
#
# Asi que el contenedor entra como root, corrige lo justo, y hace exec al
# proceso real ya como node: nada queda corriendo con privilegios.
set -eu

if [ "$(id -u)" = "0" ]; then
  for d in /app/data /app/content /app/projects; do
    [ -d "$d" ] || mkdir -p "$d"
    # El -R solo cuando el dueno esta mal. Una carpeta con meses de piezas
    # adentro tarda en recorrerse, y en el caso normal no hay nada que cambiar.
    if [ "$(stat -c %u "$d")" != "1000" ]; then
      echo "entrypoint: ajustando el dueno de $d"
      chown -R node:node "$d"
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
