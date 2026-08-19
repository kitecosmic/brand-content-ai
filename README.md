# brand-content-ai

[![licencia: AGPL-3.0](https://img.shields.io/badge/licencia-AGPL--3.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg)](https://nodejs.org)
[![dependencias](https://img.shields.io/badge/dependencias%20npm-0-brightgreen.svg)](package.json)

Generador de contenido para tus marcas. Le das la URL de una marca, arma su
identidad (paleta, tipografías, voz, hechos citables), y a partir de ahí genera
piezas — video, carrusel, imagen, texto — desde un panel web o desde Telegram.
Si algo no te gusta, se lo decís con palabras y lo rehace atendiendo el comentario.

Corre en tu PC o en un servidor, habla contra la API de MiniMax con formato
Anthropic y **no tiene una sola dependencia npm**.

---

## Cómo funciona

```
URL de la marca ──► identidad (paleta + tipografías + voz + frame.md)
       │                          │
       └──sync──► hechos citables │
                       │          │
                       ▼          ▼
     tab Crear ──► brief ──► composición ──► render ──► pieza
     calendario ──►                (HyperFrames)          │
                                                          ▼
                                            Telegram ◄── entrega + control
                                                          │
                                    /no <id> <motivo> ──► rehace atendiendo el motivo
```

Cinco decisiones que explican el resto del diseño:

**La marca es un dato, no una constante.** Se crea desde una URL: se lee el
sitio, se propone la identidad, se bajan las tipografías de Google Fonts y se
embeben en base64 (el render no tiene red). El modelo decide los valores; el
código arma el `frame.md` y el proyecto base. Podés tener varias marcas en la
misma instancia y cada pieza pertenece a una.

**El contenido sale de fuentes verificables, no de la imaginación.** `sync` lee
las fuentes de la marca — su sitio, o repos en disco — y destila qué es el
producto y qué hechos son citables, cada uno con la página o el archivo donde se
verificó. La generación sólo puede usar esos hechos. Es marketing público: un
número inventado acá termina en un anuncio.

**Los visuales son HyperFrames, no un modelo de imagen.** Composiciones HTML
renderizadas a MP4/PNG. Marca exacta, texto perfecto, resultado determinista y
sin costo por imagen. Cada pieza clona el proyecto base de su marca en vez de
regenerar el sistema de diseño — eso es lo que mantiene la marca consistente
entre piezas.

**El estado vive en SQLite, no en memoria.** El bot, el scheduler y la CLI son
procesos distintos que tienen que ver lo mismo. Cada pieza recorre
`planned → briefed → building → built → delivered → approved | rejected`, y cada
regeneración queda archivada en `revisions` para poder comparar y volver atrás.

**Telegram por long polling, no webhook.** Corre igual en una PC detrás de NAT
que en un servidor sin nada abierto hacia adentro: no hace falta IP pública ni
exponer un puerto. El bot sólo obedece al chat que configures.

---

## Puesta en marcha

**En tu PC.** No hay nada que instalar: cero dependencias npm.

```powershell
git clone https://github.com/kitecosmic/brand-content-ai
cd brand-content-ai
npm run web        # http://127.0.0.1:4317
```

**En un servidor**, con Docker. La imagen trae Node, Chrome, ffmpeg y la CLI de
HyperFrames ya instalados y fijados: el render los necesita y en una máquina
recién instalada no están. Lo único que hace falta en el servidor es Docker.

De una VPS Ubuntu recién creada a la primera pieza, entrando por SSH:

```bash
# 1. el sistema al día
sudo apt update && sudo apt upgrade -y
sudo apt install -y git

# 2. Docker (el instalador oficial deja también docker compose)
curl -fsSL https://get.docker.com | sh

# solo si entrás con un usuario común, no como root:
sudo usermod -aG docker $USER
exit    # salí y volvé a entrar: el grupo docker toma efecto al iniciar sesión
```

Esas dos últimas líneas le dan permiso al usuario de usar Docker sin `sudo`, y el
`exit` está porque el grupo recién vale al iniciar sesión de nuevo. Si entrás
como root, salteálas: ya podés.

```bash
# 3. el proyecto
git clone https://github.com/kitecosmic/brand-content-ai
cd brand-content-ai
cp .env.example .env
nano .env    # la API key de MiniMax y TZ; o dejalo vacío y cargá todo desde Ajustes
./deploy.sh
```

La primera corrida de `deploy.sh` construye la imagen y tarda unos minutos —baja
Chrome y las tipografías—; las siguientes reusan todo eso. Al terminar deja
andando el panel (con el bot, si configurás Telegram) y el ciclo diario.

El panel escucha en `127.0.0.1:4317` del servidor y **no se publica solo**, así
que la primera vez entrás por un túnel SSH desde tu máquina:

```bash
ssh -L 4317:127.0.0.1:4317 usuario@tu-servidor
```

Y abrís `http://127.0.0.1:4317` en tu navegador, donde te pide crear la cuenta.

**Con tu dominio, en vez del túnel.** Apuntá un registro `A` del dominio a la IP
del servidor, abrí los puertos 80 y 443, y poné el dominio en el `.env`:

```bash
# 4. HTTPS con dominio propio (opcional)
nano .env    # PANEL_DOMINIO=panel.tudominio.com
./deploy.sh
```

`deploy.sh` levanta Caddy, que pide el certificado a Let's Encrypt en la primera
visita y lo renueva solo. Cambiar de dominio o sacarlo es editar esa misma línea
y volver a correrlo.

De ahí en más, actualizar es `git pull && ./deploy.sh`. El resto —tamaño del
servidor, el DNS paso a paso, respaldo, diagnóstico— está en
**[docs/deploy.md](docs/deploy.md)**.

De las dos formas, el panel te lleva de la mano desde ahí:

1. **Creás tu cuenta** — email y contraseña. La primera es la dueña de la
   instalación: puede invitar al equipo y tocar los ajustes.
2. **Conectás el modelo** — pegás la API key de MiniMax
   ([platform.minimax.io](https://platform.minimax.io)). Es lo único imprescindible.
3. **Creás tu marca** — pegás la URL de tu sitio y saca de ahí los colores, la
   tipografía, el tono y de qué habla el producto.
4. **Leés sus fuentes** — de ahí salen los hechos que el contenido puede afirmar.
5. **Pedís tu primera pieza** — decís qué querés comunicar y elegís el formato.

Mientras falte alguno de esos pasos, un **tutorial** te acompaña: un cuadro chico
en la esquina que dice qué hacer en la pantalla en la que estás y, si el paso
vive en otra, te lleva. No pide datos ni ejecuta nada —la marca se crea en
Marcas, la API key se carga en Ajustes—, así que nunca hay dos lugares para lo
mismo. Los pasos se marcan solos mirando el estado real: si borrás la marca, ese
paso vuelve a estar pendiente. Se cierra con la ✕ por esta vez, o con "no volver
a mostrarlo" para siempre; el **`?`** de la barra lo trae de vuelta.

Una instalación nueva arranca **sin ninguna marca**: no se inventa una de
ejemplo. Lo primero que hacés es crear la tuya con la URL de tu sitio.

Telegram es opcional (sin él, el contenido se ve en el panel) y todo lo que se
configura desde **Ajustes** se aplica al instante, sin reiniciar. Si preferís
variables de entorno para un deploy automatizado, `cp .env.example .env` sirve
igual.

### Si venís de una versión con el nombre viejo

El proyecto se llamaba `adsai`. Al actualizar no hay que hacer nada: la primera
vez que arranca renombra solo el archivo de config, la base y la carpeta de datos,
y las variables `ADSAI_*` se siguen leyendo como respaldo de las `BCA_*`, así que
tu `.env` funciona sin tocarlo. Los proyectos ya renderizados conservan su carpeta
`.adsai/`, que se sigue leyendo; los nuevos usan `.bca/`. Lo único que se pierde
son las sesiones abiertas del panel: hay que volver a entrar una vez.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run bca marca nueva -- --url X` | crea una marca leyendo ese sitio `[--nombre N] [--colores "#a,#b"] [--notas "..."]` |
| `npm run bca marca listar` | las marcas que hay, con su paleta |
| `npm run bca marca revisar <id> "mas oscuro"` | ajusta la marca y guarda la version anterior |
| `npm run bca marca usar <id>` | cambia la marca por defecto |
| `npm run doctor` | verifica Node, el modelo, Telegram, marcas y fuentes |
| `npm run sync` | lee las fuentes de la marca activa `[-- --brand X] [--force]` |
| `npm run plan -- --days 14` | genera el calendario `[-- --brand X]` |
| `npm run generate` | construye las piezas pendientes |
| `npm run generate -- <id>` | construye una pieza puntual |
| `npm run deliver` | manda a Telegram lo que esté construido |
| `npm run bot` | deja el bot de Telegram escuchando **y levanta el panel web** `[-- --port N]` |
| `npm run web` | solo el panel web `[-- --port N]` |
| `npm run run` | ciclo completo: sync → plan (si hace falta) → generate → deliver |
| `npm run status` | qué hay y en qué estado |
| `npm run costs` | cuánto se gastó, por tipo de operación |

## El panel web — http://127.0.0.1:4317

`npm run bot` levanta el panel junto al bot; `npm run web` levanta solo el panel.

Seis pestañas, una idea por pestaña:

- **Crear** — decís qué querés comunicar, elegís formato e idioma, y sale ahora.
  No toca el calendario: es la pieza que necesitás hoy. La página muestra la fase
  en vivo (brief, componiendo, revisando el layout, renderizando).
- **Calendario** — lo planificado de la marca activa, por semana, con el estado
  de cada pieza. Desde ahí se planifica, se genera lo pendiente y se agenda a mano.
- **Marcas** — crear una marca desde una URL, ver su identidad con su tipografía
  real, y cambiarla escribiendo qué no te gusta. Cada cambio queda como revisión.
- **Costos** — cuánto se gastó, por tipo de operación.
- **Equipo** — quién entra, con qué permisos, y los links de invitación.
- **Ajustes** — la API key del modelo y su endpoint, Telegram, la ruta de ffmpeg
  y la clave única del modo viejo. Lo que guardás acá manda sobre el `.env` y se aplica sin reiniciar;
  los secretos se guardan en la base y nunca se vuelven a mostrar enteros.

Arriba: el selector de marca activa, la navegación, el `?` que enciende el
tutorial y el tema.

**El panel se pinta con la marca que estás mirando.** Los colores salen de su
paleta y los títulos de su tipografía real, que ya está embebida en disco. Cambiás
de marca y cambia la pantalla; la franja de color del borde superior es la paleta
completa. Es marca blanca de verdad, y de paso te muestra la identidad funcionando
antes de generar una sola pieza. Con cero marcas el panel cae en un neutro sobrio,
y el botón de tema fuerza claro u oscuro cuando querés ignorar la marca.

Que esto sea seguro no es casualidad: `normalizePalette` ya garantiza los
contrastes WCAG de toda paleta antes de guardarla, así que ninguna marca puede
dejar el panel ilegible.

Desde el detalle podés generar, aprobar, o escribir qué está mal y regenerar. Las
acciones largas se disparan en segundo plano y el estado real se lee de la base,
así que refrescar siempre dice la verdad.

**Cualquier entregable se mira en grande y se descarga**, sea un video, una
imagen, un carrusel o un texto. Tocás la pieza y se abre a pantalla completa; en
un carrusel las flechas (o ← →) recorren los slides sin salir del visor, y cada
uno se baja por separado. El archivo se guarda con el nombre de la pieza, no con
un id. El texto además se copia de un click.

**Una pieza que se cortó lo dice.** Si el proceso que la generaba murió (cerraste
la terminal, se reinició el servidor), la pieza queda marcada como **detenido** —
no como "generando" — con desde cuándo, en qué fase se cortó, el error real del
linter y un botón para retomarla. Y si esa pieza ya había salido bien antes, se
muestra el archivo de la revisión anterior en vez de decir que no hay nada: sigue
en disco.

**Las acciones que cuestan plata avisan primero.** "Generar lo pendiente" no
arranca: te lleva a una pantalla que dice cuántas piezas son, de qué marca, y
cuánto va a salir — estimado con el promedio real de tu instalación, formato por
formato. Un carrusel puede costar más de veinte dólares; ese número tiene que
estar antes del click y no después, en la pantalla de costos. Además genera solo
las piezas de la marca activa y entrega a Telegram solo lo que generó esa corrida.

**Las marcas se pueden borrar**, desde la lista o desde su detalle. La
confirmación dice qué se va (la identidad, su historial, sus fuentes) y qué
queda: las piezas ya generadas se conservan, huérfanas, porque costaron plata.
Si la marca fue una prueba y querés que no quede nada, hay una casilla para
borrar también sus carpetas — y solo se tocan las que están dentro de las
carpetas de proyectos y contenido de esta instalación.

**El tutorial es un cuadro sobre la pantalla real**, no una pantalla aparte. Te
para frente al formulario de verdad y te dice qué hacer ahí; "Siguiente" te lleva
a la pantalla del paso que sigue. No tiene formularios propios: cuando los tenía,
la misma cosa se podía hacer en dos lugares distintos y, desde afuera, parecía
que el asistente creaba la marca cuando en realidad la estaba mostrando.

Si una pieza falla en una fase que mejora sola al reintentar (layout flojo, el
linter en contra, una escena que el modelo no entrego), el sistema la reintenta solo
una vez antes de darla por fallada: `limits.retriesPerItem` en la config, 0 para
volver al comportamiento de apretar generar a mano.

**Cuando `hyperframes check` falla, la reparación es una conversación**, no un
parche a ciegas. El modelo recibe el dictamen separado en lo que bloquea el
render (los `error`) y lo que es cosmético (warnings e infos, con los que el
check pasa igual), con los archivos marcados; escribe; se corre el check; y el
resultado le vuelve como mensaje siguiente de la misma conversación — qué error
sobrevivió a su arreglo, cuál apareció, cuál se fue. Hasta `limits.repairTurns`
vueltas (4) y `limits.repairTokenBudget` tokens.

Si el **mismo** error bloqueante (misma regla, archivo, selector y tiempo) vuelve
vuelta tras vuelta, se escala en vez de insistir: la segunda vez se le dice al
modelo que su arreglo no sirvió y que cambie de planteo; la tercera se descarta
esa escena y se recompone desde el brief; la cuarta corta con `check-estancado`,
que **no** se reintenta — sobrevivió a dos reparaciones y a rehacer la escena, así
que el brief pide algo que esa escena no puede cumplir, y eso lo decide una
persona (rechazar la pieza con un comentario rehace el brief). Todo esto queda en
la **bitácora** de la pieza, que el panel muestra en vivo mientras corre y
después, con lo bloqueante distinguido de lo cosmético.

Cuando el puerto 4317 esta ocupado, el arranque dice que PID lo tiene y como
cerrarlo; para levantarlo en otro puerto, `npm run bot -- --port 4318`.

### Publicarlo en un servidor

El panel **se niega a escuchar fuera de 127.0.0.1 si no hay forma de
autenticarse** — ni cuentas creadas ni `BCA_PANEL_PASSWORD`. Un panel abierto
es la tarjeta de crédito de cualquiera que pase. Con tu cuenta ya creada, podés
publicarlo directamente. Para verlo desde otra máquina sin publicarlo, un túnel
SSH:

```bash
ssh -L 4317:127.0.0.1:4317 tu-usuario@tu-pc
```

Para publicarlo de verdad: creá tu cuenta primero, ponelo detrás de HTTPS
(nginx, Caddy, Cloudflare) y arrancá con el bind abierto.

```bash
npm run web -- --host 0.0.0.0
```

Las sesiones sobreviven a los reinicios solas: el secreto con el que se firman se
guarda en la base la primera vez. `BCA_SESSION_SECRET` sigue existiendo para
manejarlo desde el entorno o rotarlo cuando quieras.

`BCA_PANEL_PASSWORD` sigue existiendo para instalaciones que venían con una
clave compartida: si hay cuentas creadas, se ignora.

Con el despliegue de Docker esto ya viene resuelto y no hace falta abrir el bind:
el contenedor comparte la red del servidor, así que el panel escucha en loopback
como en cualquier instalación, y quien lo expone es Caddy —que `deploy.sh` levanta
si pusiste `PANEL_DOMINIO` en el `.env`— con su certificado y su renovación
automática. Detrás de HTTPS, la cookie de sesión sale marcada `Secure`.

## Formatos

| Formato | Qué sale | Lienzo |
|---|---|---|
| `text` | post listo para pegar | — |
| `image` | una imagen | 1080×1080 |
| `story` | historia vertical a pantalla completa | 1080×1920 |
| `carousel` | 6 slides | 1080×1350 |
| `video` | MP4 horizontal | 1920×1080 |
| `reel` | MP4 vertical corto | 1080×1920 |

Los verticales (`story`, `reel`) se componen para la **franja central**: Instagram,
WhatsApp y Facebook dibujan su interfaz sobre la pieza —el avatar arriba, la barra
de respuesta abajo—, así que nada legible entra en el 14% superior ni en el 20%
inferior. El fondo sí llega a los bordes; el texto no. El titular manda: ocupa el
tercio superior de la zona viva y es 3 a 5 veces más grande que el resto.

**Agregar un formato tuyo** no requiere tocar el pipeline. En `brand-content-ai.config.json`:

```json
"portada": { "enabled": true, "kind": "still", "aspect": "1200x630", "engine": "hyperframes" }
```

`kind` es lo único que el sistema necesita saber: `text` (el brief es el
entregable), `still` (una imagen), `slides` (varias) o `motion` (video). El
lienzo, la duración y la cantidad de slides salen del mismo bloque.

## Desde Telegram (opcional)

Sin Telegram configurado, Brand Content AI funciona completo: se crea, se genera y se
revisa todo desde el panel. Telegram agrega dos cosas: recibir la pieza en el
celular apenas está lista, y controlar el sistema por chat.


| Comando | Qué hace |
|---|---|
| `/hoy` | qué toca hoy |
| `/pendientes` | lo que falta entregar |
| `/plan 14` | replanificar |
| `/generar <id>` | forzar una pieza |
| `/ok <id>` | aprobar |
| `/no <id> <motivo>` | rechazar y regenerar **atendiendo el motivo** |
| `/costos` | gasto |
| `/ayuda` | ayuda |

El `/no` es la pieza central: el motivo entra en el prompt del siguiente brief y
queda archivado junto con la versión que descartaste.

## Dejarlo corriendo solo

**En un servidor, con Docker.** Es lo que hace que corra de verdad las 24 horas.
`./deploy.sh` deja dos servicios andando: el panel —con el bot, si Telegram está
configurado— y el ciclo diario, que a la hora de `calendar.publishHourLocal`
corre sync → plan → generate → deliver. Docker los levanta de nuevo si se caen o
si reiniciás la máquina, y actualizar es `git pull && ./deploy.sh`. El runbook
está en [docs/deploy.md](docs/deploy.md).

**En tu PC, con el Programador de tareas de Windows.** Dos procesos:

**El bot, siempre vivo.** Tarea al iniciar sesión, reinicio ante fallo:

```powershell
schtasks /Create /TN "brand-content-ai-bot" /SC ONLOGON /RL LIMITED ^
  /TR "cmd /c cd /d C:\ruta\a\brand-content-ai && npm run bot" /F
```

**El ciclo diario.** Una vez por día, a la hora que definas en
`brand-content-ai.config.json` (`calendar.publishHourLocal`):

```powershell
schtasks /Create /TN "brand-content-ai-run" /SC DAILY /ST 09:00 ^
  /TR "cmd /c cd /d C:\ruta\a\brand-content-ai && npm run run" /F
```

> Con la PC apagada no se genera nada: esa es la contrapartida de correr local,
> y es la razón de la opción de arriba.

## Costo

Cada llamada al backend gasta por tokens de entrada y salida, y Brand Content AI calcula
el costo localmente con `brand-content-ai.config.json -> minimax.pricing` (USD por 1K
tokens: `{ input, output, cacheRead }`; los tokens que MiniMax sirve desde
cache se cobran aparte y mucho mas barato). Cada tarea elige su modelo en
`cfg.models`:

```json
"models": {
  "plan":    "MiniMax-M3",
  "brief":   "MiniMax-M3",
  "copy":    "MiniMax-M3",
  "compose": "MiniMax-M3",
  "repair":  "MiniMax-M3",
  "review":  "MiniMax-M3",
  "digest":  "MiniMax-M3"
}
```

`review` es el modelo que **mira** las escenas fotografiadas (tiene que aceptar
imágenes); `compose` ya no escribe HTML, elige layouts.

Todo en M3 por calidad consistente: la diferencia de costo entre modelos no
compensa el ruido cuando el digest dice una cosa y el brief/compose dice otra.
Si querés ahorrar en tareas mecánicas, agregás el modelo chico al bloque
`pricing` y lo cambiás puntualmente acá.

Los precios que vienen en la config son la tarifa publicada de MiniMax-M3
(agosto 2026: $0,30/M de entrada, $1,20/M de salida, $0,06/M de lectura de
cache) para pedidos de hasta 512K tokens de entrada; arriba de eso la tarifa
se duplica. Si un modelo no tiene pricing configurado, su `cost_usd` queda en
`null` y `npm run costs` lo cuenta como 0.

`npm run costs` muestra el gasto real por tipo de operación. El propio render
de HyperFrames no cuesta nada (es Chrome local); lo que se paga es que el
modelo elija y rellene los layouts, que mire las escenas fotografiadas y,
cuando algo falla, que lo repare.

Dónde se va la plata, en orden:

1. **Compose** — una llamada JSON por pieza: el modelo elige un layout
   prefabricado por escena (`src/lib/layouts.mjs`: hero, statement, stat,
   split, cues, steps, cta) y rellena sus huecos con el copy del brief; el
   código renderiza el HTML. Es barato (nada de 300 líneas de HTML por escena)
   y es lo que hace que las piezas se lean como una serie, en cualquier marca:
   los layouts no traen un solo color ni familia propios, todo sale de la paleta
   y las tipografías del `frame.md` de la marca.
2. **Revisión visual** — cada escena se fotografía y el modelo de visión la
   mira contra una lista corta (palabras partidas, texto cortado, solapes,
   mitades vacías, copy faltante). Unos 2k tokens por foto. Si observa algo, la
   reparación recibe la foto adjunta y vuelve a fotografiarse; hasta
   `limits.reviewTurns` (2) vueltas, y agotarlas no frena la pieza.
3. **Reparaciones (cuando `check` falla)** — son mecánicas (aplicar el
   dictamen del linter). También van a M3: el ahorro de un modelo chico no
   compensa la inconsistencia con el resto del flujo. Van en una sola
   conversación por sesión de check, con el prefijo largo (frame.md, la
   composición de referencia, las escenas) marcado como cacheable
   (`cache_control`): cada vuelta lo repite y el endpoint lo cobra a precio de
   lectura de cache. Cuántos tokens vinieron del cache queda en la fila de
   `runs` de cada vuelta.
4. **Brief** — una llamada por pieza.

El regulador más grande es el mix: un video o carrusel cuesta ~20× lo que un
post de texto, así que bajarlos en `calendar.mix` (o menos escenas por pieza)
recorta el gasto de forma directa.

## Estructura

```
brand-content-ai.config.json     formatos, cadencia, modelos, limites (la marca vive en la base)
.env                  secretos (git-ignored)
src/cli.mjs           el unico lugar que imprime a consola
src/lib/
  config.mjs          config + .env + utilidades de fecha
  store.mjs           SQLite: marcas, items, revisiones, fuentes, costos
  modelo.mjs          wrapper HTTP del backend MiniMax (formato Anthropic)
  layouts.mjs         los layouts prefabricados de escena, para cualquier marca
  brand.mjs           crear e iterar marcas: identidad, frame.md, proyecto base
  site.mjs            leer un sitio (texto, colores, tipografias) sin dependencias
  fonts.mjs           Google Fonts -> CSS con las fuentes embebidas en base64
  knowledge.mjs       fuentes -> digest + hechos citables
  calendar.mjs        calendario de contenido
  generate.mjs        brief -> composicion -> render
  telegram.mjs        entrega + bot de control
  web.mjs             panel: ruteo, acciones, login
  views.mjs           las vistas del panel (HTML puro)
  ui.mjs              layout, estilos (tematizados por marca) y el JS propio
  color.mjs           hex, contraste WCAG y mezcla — lo usan brand.mjs y ui.mjs
Dockerfile            la imagen del servidor: Node + Chrome + ffmpeg + la CLI
docker-compose.yml    los dos servicios del servidor: panel y ciclo diario
deploy.sh             el redespliegue, despues de un git pull
docker/               arranque, entrypoint, ciclo diario y el Caddyfile del proxy
docs/deploy.md        el runbook del servidor
CONTRACTS.md          contratos internos entre modulos
```

**Nada tuyo vive en la carpeta del codigo.** La configuracion de tu maquina, los
secretos y los datos van aparte, para que el repo se pueda clonar, comprimir o
publicar sin llevarse nada:

```
%LOCALAPPDATA%\brand-content-ai\   (Windows)   ~/.config/brand-content-ai/   (Linux y macOS)
  config.json               rutas de repos, projectsDir, marca semilla
  .env                      secretos, si preferis archivo antes que la pantalla de Ajustes
  data/brand-content-ai.db             marcas, calendario, costos y los ajustes guardados
  data/font-cache/          tipografias ya descargadas
  content/                  las piezas generadas
```

Se mueve entero con `BCA_HOME`. Una instalacion que ya tenia `./data` la sigue
usando: cambiarla de lugar romperia las rutas de las piezas ya generadas.

En el servidor con Docker esas carpetas se montan desde el repo —`data/`,
`content/` y `projects/`, las tres git-ignored— para que el respaldo sea una sola
carpeta y sobrevivan a cada redeploy.

## El equipo

Todos los que entran ven las mismas marcas y pueden crear, generar y descargar
contenido. La diferencia está en dos cosas:

| | Dueño | Miembro |
|---|---|---|
| Crear y generar contenido, descargar | sí | sí |
| Crear y ajustar marcas | sí | sí |
| Ajustes (API keys, Telegram) | sí | no |
| Invitar y sacar gente | sí | no |
| Borrar una marca | sí | no |

**Invitar** genera un link de un solo uso que vence en 7 días — se lo pasás por
donde quieras. No hay servidor de correo y no vamos a pedirte uno para sumar a
tres personas. Si ponés el email al invitar, esa invitación sólo sirve para ese
email; si lo dejás vacío, sirve para quien tenga el link.

Sacar a alguien le corta el acceso **en el acto**: la sesión se valida contra la
base en cada request, no contra un token que sobrevive.

Las contraseñas se guardan con `scrypt` y salt por usuario. No hay recuperación
por email (no hay correo saliente): si alguien la pierde, el dueño le genera una
invitación nueva.

## Licencia

**AGPL-3.0-or-later.** Podés usarlo, estudiarlo, modificarlo y desplegarlo
—incluso dentro de una empresa— gratis. La contrapartida es la cláusula de red:
si ofrecés una versión modificada **a través de internet**, tenés que
publicar el código de esa versión bajo la misma licencia. Por eso el panel
muestra un link al código fuente en el pie: si lo forkeás y lo desplegás,
apuntá `REPO_URL` en `src/lib/ui.mjs` a tu fork.

Lo que la AGPL **no** hace: impedir que alguien cobre. Un competidor puede montar
un SaaS con este código y facturarlo, siempre que publique sus modificaciones.
Si querés que no pueda hacerlo sin tu permiso, el camino habitual es la **licencia
dual**: este repo sigue en AGPL, y a quien no quiera cumplir la AGPL (porque
quiere cerrar su código o revenderlo) le vendés una licencia comercial. Es lo que
hacen MongoDB, Grafana e iText. Para eso hace falta que todos los aportes lleguen
con un CLA — sin eso, no podés relicenciar el código de otros.

Para una licencia comercial: abrí un issue o escribí al mail del perfil.

## Otra marca

Desde el panel (tab **Marcas**) o desde la terminal:

```bash
npm run bca marca nueva -- --url https://otramarca.com --notas "mas calida, publico no tecnico"
npm run bca marca usar otramarca
npm run sync
```

Lo que hace: lee el sitio (incluso si es una SPA — busca el copy en el payload
de hidratación y en el bundle), propone identidad, ajusta la paleta hasta que
cumpla contraste WCAG, baja las tipografías y escribe el `frame.md`. Después se
itera hablando:

```bash
npm run bca marca revisar otramarca "el acento en violeta y menos serifas"
```

Cada revisión guarda la anterior: si el cambio empeoró la marca, la versión
previa sigue en el historial.

Los repos de `brand-content-ai.config.json` siguen valiendo para la marca original — un
repo es otra clase de fuente, igual que una URL.
