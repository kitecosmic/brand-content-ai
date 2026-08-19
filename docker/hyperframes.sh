#!/bin/sh
#
# `hyperframes ...` dentro del contenedor, con la version que usa el proyecto.
#
# La CLI se invoca siempre por npx, y npx cachea por version exacta: un
# `npx hyperframes doctor` a secas resuelve "latest" y se pone a descargar otra
# copia, que ademas no es la que renderiza tus piezas. Este envoltorio lee la
# version del config —la misma que precargo el build— asi que diagnosticar el
# servidor no baja nada ni miente sobre lo que esta instalado.
set -eu

VERSION="$(node -p "require('/app/brand-content-ai.config.json').hyperframes?.cliVersion || 'latest'")"
exec npx --yes "hyperframes@${VERSION}" "$@"
