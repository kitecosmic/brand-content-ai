# Brand Content AI en un contenedor: Node, Chrome, ffmpeg y la CLI de HyperFrames.
#
# Lo que resuelve esta imagen es la parte fragil del despliegue. El render no es
# "correr node": abre un Chrome de verdad, graba frame a frame y encodea con
# ffmpeg, y eso arrastra una lista de librerias del sistema que en un servidor
# recien instalado no estan. Aca quedan fijadas de una vez.
#
# La lista de paquetes no la invente: es la del Dockerfile.render que publica la
# propia CLI de HyperFrames, que es la que sabe que necesita su Chrome.
#
# Debian bookworm y x86_64 a proposito: `sharp` y `onnxruntime-node` (dependencias
# de la CLI) son binarios nativos contra glibc — en Alpine no arrancan — y
# chrome-for-testing no publica build para linux-arm64.
FROM node:22-bookworm-slim

# ffmpeg trae tambien ffprobe, que la CLI busca por separado.
#
# Las tipografias del sistema hacen falta aunque las de marca viajen embebidas
# en base64 dentro del CSS del proyecto: Chrome necesita una familia de respaldo
# y los emoji. Sin ellas el render dibuja cajitas y la revision visual las
# reporta como texto ilegible, que es un sintoma que despista.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git ffmpeg chromium \
      libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \
      libxdamage1 libxrandr2 libcups2 libasound2 libpangocairo-1.0-0 \
      libxshmfence1 libgtk-3-0 \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-noto-core \
      fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean \
 && fc-cache -f

# El Chrome ya esta instalado por apt: que puppeteer no intente bajarse otro.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CONTAINER=true \
    NODE_ENV=production

# Ademas del chromium de la distro se instala chrome-headless-shell, que es el
# navegador que la CLI prefiere para renderizar: viene de chrome-for-testing con
# la version fijada por el canal stable, en vez de seguir al chromium que Debian
# vaya actualizando. Importa porque el resultado del render depende del
# navegador —contraste, tipografia, un pixel de mas— y `check` mide justamente
# eso. Se deja en una ruta fija por symlink, porque el directorio real
# lleva el numero de version adentro y ENV no puede leer la salida de un RUN.
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path /opt/hf-browsers \
 && ln -s "$(find /opt/hf-browsers -name chrome-headless-shell -type f | head -1)" \
          /usr/local/bin/chrome-headless-shell \
 && /usr/local/bin/chrome-headless-shell --version
ENV PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/chrome-headless-shell

WORKDIR /app
RUN chown node:node /app

# El config viaja en la imagen (es codigo, no dato) y lo leen dos cosas: el
# envoltorio de aca abajo y el precargado de la CLI.
COPY brand-content-ai.config.json ./

# `hyperframes ...` a secas, con la version que usa el proyecto. Diagnosticar el
# servidor con `npx hyperframes doctor` resolveria "latest" y se pondria a bajar
# una version distinta de la que renderiza tus piezas — que es justo lo que no
# queres saber cuando algo falla.
COPY docker/hyperframes.sh /usr/local/bin/hyperframes
RUN chmod +x /usr/local/bin/hyperframes

# El proyecto corre como usuario sin privilegios, y por eso lo que sigue se
# instala como el: un Chrome que abre HTML generado por un modelo no tiene por
# que ser root, y los volumenes quedan escritos con uid 1000 —el primer usuario
# de Ubuntu— asi que en el host los archivos son tuyos y no de root.
#
# La cache de npx que se llena abajo tiene que ser la de este usuario, que es
# quien despues la va a leer.
USER node
ENV HOME=/home/node

# La CLI de HyperFrames se invoca con `npx hyperframes@<version>` en cada render.
# Aca se descarga durante el build para que quede en la cache de npx: en runtime
# npx la encuentra por hash y no sale a la red. Sin esto, la primera generacion
# del servidor gasta parte de su timeout bajando la CLI.
#
# La version sale del config del proyecto, no de un numero escrito a mano aca:
# si cambias cfg.hyperframes.cliVersion, el proximo build precarga la nueva.
RUN hyperframes --version

# El codigo va ultimo: es lo unico que cambia en un `git pull`, asi que un
# redeploy solo rehace esta capa y las de arriba salen de cache.
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node docker/ ./docker/

# El contenedor entra como root solo para dejar los volumenes escribibles; el
# entrypoint baja a `node` antes de ejecutar nada del proyecto.
USER root
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint"]

# Sin argumentos levanta el panel (y el bot, si Telegram esta configurado).
CMD ["node", "--disable-warning=ExperimentalWarning", "docker/arranque.mjs"]
