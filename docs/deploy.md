# Desplegar en un servidor

Brand Content AI corre en un VPS con Docker. La imagen trae Node, Chrome, ffmpeg
y la CLI de HyperFrames ya instalados y fijados, así que el servidor no necesita
nada más que Docker: no hay que instalar navegadores ni librerías a mano, y la
versión de cada cosa es la misma acá que en tu máquina.

El mantenimiento del día a día son dos comandos:

```bash
git pull && ./deploy.sh
```

**Qué corre.** Dos servicios sobre la misma imagen:

| Servicio | Qué hace |
|---|---|
| `panel` | el panel web y, si Telegram está configurado, el bot en el mismo proceso |
| `ciclo` | el ciclo diario (sync → plan → generate → deliver) a `calendar.publishHourLocal` |

Son dos procesos y no uno porque el estado vive en SQLite y ya está pensado para
compartirse: así una generación que se cuelga no se lleva puesto el panel.

**Qué queda en el host.** `data/` (la base, con marcas, calendario, costos y tus
API keys), `content/` (las piezas entregadas) y `projects/` (los proyectos de
HyperFrames, uno por pieza). Se montan como volúmenes: reconstruir la imagen o
borrar el contenedor no toca nada de eso.

## Tamaño del servidor

**4 vCPU / 8 GB RAM / 60 GB SSD** es cómodo. El render abre un Chrome de verdad y
graba frame a frame; con `limits.maxConcurrentGenerations: 2` pueden correr dos a
la vez, y en 4 vCPU eso es contención pura. En un servidor de 4 núcleos conviene
bajarlo a 1 (ver *Ajustes del servidor*, más abajo).

Con menos de 8 GB, agregá swap: un OOM a mitad de un render tira una pieza que ya
gastaste en tokens.

El disco lo come `projects/`: cada pieza deja su proyecto y su MP4. Mirá cuánto
crece el primer mes y borrá los viejos si hace falta.

## Instalación

**1. Docker.** En Ubuntu:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # y volvé a entrar por SSH
```

Si el instalador todavía no publica paquetes para tu versión de Ubuntu, los de la
distro alcanzan: `sudo apt install -y docker.io docker-compose-v2`.

**2. El proyecto y sus secretos.**

```bash
git clone https://github.com/kitecosmic/brand-content-ai.git
cd brand-content-ai
cp .env.example .env
nano .env      # BCA_MINIMAX_API_KEY, TZ, y Telegram si lo vas a usar
```

Poné también `BCA_SESSION_SECRET` con una cadena larga y random: sin eso, cada
redeploy cierra las sesiones abiertas del panel.

`TZ` tiene que coincidir con `calendar.timezone` del config. La hora de
publicación es hora local, y un servidor recién instalado está en UTC.

**3. Levantarlo.**

```bash
./deploy.sh
```

La primera vez tarda unos minutos: construye la imagen, instala Chrome y precarga
la CLI de HyperFrames. Los redeploys siguientes reusan todo eso y solo rehacen la
capa del código.

**4. Crear tu cuenta.** El panel escucha en `127.0.0.1:4317` del servidor y **se
niega a publicarse solo**, así que la primera vez entrás por un túnel SSH desde
tu máquina:

```bash
ssh -L 4317:127.0.0.1:4317 usuario@tu-servidor
```

Y abrís `http://127.0.0.1:4317` en tu navegador: te pide crear la cuenta dueña.
Desde ahí cargás la marca (tab Marcas, con la URL de tu sitio) y sincronizás.

**5. Verificar.**

```bash
docker compose exec -u node panel node --disable-warning=ExperimentalWarning src/cli.mjs doctor
docker compose exec -u node panel hyperframes doctor
```

El primero revisa el backend del modelo, la cuenta, la marca y el conocimiento
sincronizado. El segundo revisa lo del render: CPU, memoria, disco, ffmpeg,
Chrome y `/dev/shm`.

## Publicarlo con HTTPS

El panel queda en loopback; quien lo expone es un proxy del host. Con Caddy son
tres líneas y el certificado se renueva solo:

```
panel.tudominio.com {
    reverse_proxy 127.0.0.1:4317
}
```

El panel ya lee `x-forwarded-proto`, así que los redirects salen bien. En el
firewall: 22, 80 y 443, nada más — el 4317 nunca se abre hacia afuera.

Si preferís no exponerlo, el túnel SSH del paso 4 sirve para siempre.

## Mantenimiento

```bash
git pull && ./deploy.sh          # actualizar
docker compose logs -f           # ver todo
docker compose logs -f ciclo     # solo el ciclo diario
docker compose restart panel     # reiniciar sin reconstruir
docker compose down              # bajar todo (los datos quedan)
```

Los reinicios por caída los maneja Docker (`restart: unless-stopped`), y el panel
tiene healthcheck: `docker compose ps` te dice si está sano.

Cada tanto conviene traer los parches de seguridad de la imagen base y limpiar
las capas que quedaron sueltas de los redeploys, que ocupan disco:

```bash
docker compose build --pull && docker compose up -d
docker image prune -f
```

**Respaldo.** Lo importante es `data/` (incluye la base con las API keys) y
`content/`:

```bash
tar czf respaldo-$(date +%F).tar.gz data content
```

`projects/` no hace falta respaldarlo: es material de trabajo, se regenera.

**Ajustes del servidor.** Para cambiar límites sin tocar el config del repo —que
se pisa en cada `git pull`— creá `data/config.local.json`, que el contenedor ya
lee. Por ejemplo, una sola generación a la vez:

```json
{ "limits": { "maxConcurrentGenerations": 1 } }
```

Se mezcla en profundidad con `brand-content-ai.config.json`: solo escribís lo que
cambiás. Después, `docker compose restart`.

**Probar el ciclo sin esperar a la hora.** `CICLO_AL_ARRANCAR=1` en el `.env` y
`docker compose up -d ciclo`: genera apenas levanta. Sacalo después.

## Cuando algo falla

**El render falla o se cuelga.** `docker compose exec -u node panel hyperframes doctor`.
Si se queja de `/dev/shm`, es que el `shm_size: 2gb` del compose no se
aplicó (¿editaste el archivo?): con los 64 MB por defecto Chrome muere a mitad
del render.

**El panel no responde.** `docker compose ps` y `docker compose logs panel`. Si
reinicia en bucle, casi siempre es el `.env`: una API key mal pegada o Telegram a
medio configurar.

**El ciclo no corrió.** `docker compose logs ciclo` muestra a qué hora se despertó
y qué pasó. Si arrancó a destiempo, `TZ` no coincide con `calendar.timezone` —el
propio ciclo lo avisa al levantar.

**Se llenó el disco.** `du -sh projects content data`. Casi siempre es
`projects/`: borrá los de las piezas viejas.

## Mudarte desde tu PC

Empezá limpio en el servidor: creá la marca de nuevo desde el panel y sincronizá.
Copiar `data/` desde Windows arrastra las rutas absolutas (`C:\...`) de las piezas
ya generadas, que en el contenedor no resuelven — la base funcionaría, pero cada
pieza vieja quedaría sin archivo.
