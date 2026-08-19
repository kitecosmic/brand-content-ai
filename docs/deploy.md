# Desplegar en un servidor

Brand Content AI corre en un VPS con Docker. La imagen trae Node, Chrome, ffmpeg
y la CLI de HyperFrames ya instalados y fijados, así que el servidor no necesita
nada más que Docker: no hay que instalar navegadores ni librerías a mano, y la
versión de cada cosa es la misma acá que en tu máquina.

El mantenimiento del día a día son dos comandos:

```bash
git pull && ./deploy.sh
```

**Qué corre.**

| Servicio | Qué hace |
|---|---|
| `panel` | el panel web y, si Telegram está configurado, el bot en el mismo proceso |
| `ciclo` | el ciclo diario (sync → plan → generate → deliver) a `calendar.publishHourLocal` |
| `caddy` | HTTPS en tu dominio, solo si pusiste `PANEL_DOMINIO` en el `.env` |

`panel` y `ciclo` son dos procesos y no uno porque el estado vive en SQLite y ya
está pensado para compartirse: así una generación que se cuelga no se lleva
puesto el panel.

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

**1. El sistema al día.** En una VPS recién creada, lo primero:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git
sudo apt autoremove -y
```

Si `upgrade` tocó el kernel, Ubuntu deja una marca y conviene reiniciar antes de
seguir:

```bash
[ -f /var/run/reboot-required ] && sudo reboot
```

**2. Docker.** El instalador oficial deja el engine y `docker compose`:

```bash
curl -fsSL https://get.docker.com | sh

# solo si entrás con un usuario común, no como root:
sudo usermod -aG docker "$USER"
exit    # salí y volvé a entrar por SSH: el grupo toma efecto al iniciar sesión
```

El `usermod` es lo que deja usar Docker sin `sudo`, y el grupo recién vale al
iniciar sesión de nuevo — por eso el `exit`. Como root no hace falta ninguno de
los dos. Al volver, `docker run --rm hello-world` tiene que andar sin `sudo`.

Si el instalador todavía no publica paquetes para tu versión de Ubuntu, los de la
distro alcanzan: `sudo apt install -y docker.io docker-compose-v2`.

**3. El proyecto y sus secretos.**

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

**4. Levantarlo.**

```bash
./deploy.sh
```

La primera vez tarda unos minutos: construye la imagen, instala Chrome y precarga
la CLI de HyperFrames. Los redeploys siguientes reusan todo eso y solo rehacen la
capa del código.

**5. Crear tu cuenta.** El panel escucha en `127.0.0.1:4317` del servidor y **se
niega a publicarse solo**, así que la primera vez entrás por un túnel SSH desde
tu máquina:

```bash
ssh -L 4317:127.0.0.1:4317 usuario@tu-servidor
```

Y abrís `http://127.0.0.1:4317` en tu navegador: te pide crear la cuenta dueña.
Desde ahí cargás la marca (tab Marcas, con la URL de tu sitio) y sincronizás.

**6. Verificar.**

```bash
docker compose exec -u node panel node --disable-warning=ExperimentalWarning src/cli.mjs doctor
docker compose exec -u node panel hyperframes doctor
```

El primero revisa el backend del modelo, la cuenta, la marca y el conocimiento
sincronizado. El segundo revisa lo del render: CPU, memoria, disco, ffmpeg,
Chrome y `/dev/shm`.

## Publicarlo en tu dominio, con HTTPS

Poné el dominio en el `.env` y `./deploy.sh` levanta Caddy: publica el panel ahí,
pide el certificado a Let's Encrypt y lo renueva solo. No hay certificado que se
venza un domingo ni cron que recordar.

**1. Apuntá el DNS al servidor.** En el panel de tu proveedor de dominio, un
registro `A`:

| Tipo | Nombre | Valor |
|---|---|---|
| `A` | `panel` (o `@` para el dominio pelado) | la IP del servidor |

Esperá a que propague y verificá **desde el servidor**. Si esto no devuelve tu
IP, Caddy no va a poder sacar el certificado y no tiene sentido seguir:

```bash
getent hosts panel.tudominio.com     # o: dig +short panel.tudominio.com
```

**2. Abrí los puertos 80 y 443.** El 80 no es opcional: por ahí verifica Let's
Encrypt que el dominio es tuyo, y por ahí redirige Caddy a HTTPS.

```bash
sudo ufw status                      # si dice "inactive", no hay nada que hacer
sudo ufw allow 80,443/tcp            # si está activo
```

Si tu proveedor tiene su propio firewall —Hetzner Cloud Firewall, los Security
Groups de AWS— abrilos también ahí: son dos capas distintas.

**3. Poné el dominio en el `.env`.**

```bash
nano .env
```

```
PANEL_DOMINIO=panel.tudominio.com
```

**4. Desplegá.**

```bash
./deploy.sh
```

El script ve el dominio, activa el servicio de Caddy y te lo dice. También
escribe `COMPOSE_PROFILES=dominio` en tu `.env`, que es lo que hace que
`docker compose logs`, `ps` y `restart` incluyan a Caddy sin ningún flag.

**5. Verificá.** El certificado se pide en la primera visita al dominio:

```bash
curl -I https://panel.tudominio.com          # tiene que responder 303 o 200
docker compose logs caddy | grep -i "certificate obtained"
```

Y entrás desde cualquier navegador a `https://panel.tudominio.com`. Ya no hace
falta el túnel SSH — aunque sigue funcionando, si lo preferís.

### Cambiar de dominio, o sacarlo

Las dos cosas son editar el `.env` y volver a desplegar:

```bash
nano .env        # PANEL_DOMINIO=otro.tudominio.com  (o vacío para sacarlo)
./deploy.sh
```

Con un dominio nuevo, Caddy pide el certificado que corresponda; el anterior
queda guardado en el volumen por si volvés. Vaciando la variable, `deploy.sh`
baja Caddy y el panel vuelve a quedar solo en `127.0.0.1:4317`.

Para reiniciar el proxy sin tocar el panel:

```bash
docker compose restart caddy
docker compose logs -f caddy
```

### Si el certificado no sale

```bash
docker compose logs caddy | tail -30
```

Casi siempre es una de estas tres:

- **El DNS no apunta al servidor todavía.** `getent hosts tu.dominio.com` desde
  el servidor tiene que devolver su propia IP. Si acabás de crear el registro,
  puede tardar; Caddy reintenta solo.
- **El puerto 80 está ocupado o cerrado.** `sudo ss -tlnp | grep -E ':(80|443)'`
  te dice quién lo tiene: si hay un nginx o un apache viejo, hay que pararlo
  (`sudo systemctl disable --now nginx`).
- **Let's Encrypt te frenó por repetir.** Son cinco certificados por dominio por
  semana. Si probaste muchas veces con el DNS mal, esperá — el mensaje del log
  dice cuánto.

El panel, del otro lado, ya está preparado: lee `x-forwarded-proto` (que Caddy
manda solo), así que los redirects salen en `https` y las cookies de sesión se
marcan `Secure`. El 4317 nunca se abre hacia afuera; en el firewall alcanza con
22, 80 y 443.

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

Cada tanto conviene traer los parches de seguridad de la imagen base y limpiar lo
que dejan los redeploys, que es lo que de verdad come disco: cada build deja una
imagen sin tag y una tanda de capas en la caché.

```bash
docker system df                 # cuanto ocupa cada cosa
docker compose build --pull && docker compose up -d
docker image prune -f            # imagenes viejas de redeploys anteriores
docker builder prune -f          # la cache de build, que es la que mas crece
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
