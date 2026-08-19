# Contratos internos de Brand Content AI

Documento de referencia para quien escriba un modulo. **Los modulos ya escritos
no se tocan** — se consumen tal cual estan.

## Reglas del proyecto

- **Cero dependencias npm.** Node >= 22.5. Usar `node:sqlite`, `fetch` global,
  `node:test`. Si algo parece necesitar un paquete, casi siempre no lo necesita.
- ESM (`.mjs`), `import`/`export`. Nada de CommonJS.
- Windows es el entorno primario: rutas con `node:path`, nunca concatenar con `/`.
- Todo lo que persiste va por `Store`. Nada de estado en memoria entre procesos.
- Todo lo que llama al modelo va por `runModelo` / `runModeloJSON`. El wrapper
  habla contra `cfg.minimax.baseUrl/messages` con la cabecera `anthropic-version`
  (`baseUrl` = endpoint Anthropic-compatible: `https://api.minimax.io/anthropic/v1`,
  o `https://api.minimaxi.com/anthropic/v1` para keys de China continental);
  el secreto se carga de `cfg.secrets.minimaxApiKey` (`BCA_MINIMAX_API_KEY`).
- Los errores se lanzan; el CLI los formatea. Un modulo no imprime a consola salvo
  que reciba un `log` explicito.

## Base

### `src/lib/config.mjs`

```js
loadConfig() -> cfg     // brand-content-ai.config.json + .env, con cfg.paths y cfg.secrets
today(d?) -> "YYYY-MM-DD"
addDays(isoDate, n) -> "YYYY-MM-DD"
slugify(s, max?) -> string
env(nombre) -> string   // BCA_<nombre> ?? ADSAI_<nombre> ?? ""
rutaMeta(dir, ...partes) -> string   // dir/.bca/..., o el .adsai/ viejo si ya existe
ROOT                    // raiz del proyecto
META_DIR                // ".bca"
PAQUETE                 // "brand-content-ai"
```

**Rename.** El proyecto se llamaba `adsai`. Nada de eso rompe una instalacion
existente y toda la compatibilidad vive aca:

| Que | Antes | Ahora | Como convive |
|---|---|---|---|
| config | `adsai.config.json` | `brand-content-ai.config.json` | se renombra al arrancar |
| base | `data/adsai.db` | `data/brand-content-ai.db` | idem, con `-wal` y `-shm` |
| carpeta | `.../adsai` | `.../brand-content-ai` | idem |
| entorno | `ADSAI_*` | `BCA_*` | `env()` lee las dos |
| meta del proyecto | `.adsai/` | `.bca/` | `rutaMeta()` prefiere la que exista |
| marcador de fuentes | `@@ADSAI_FONTS@@` | `@@BCA_FONTS@@` | `injectFonts` acepta los dos |
| cookies | `adsai_*` | `bca_*` | no convive: cierra las sesiones una vez |

Los strings viejos viven en la constante `VIEJO` de `config.mjs` y **no hay que
actualizarlos**: son los nombres que se buscan para migrar.

`cfg.paths = { root, db, knowledge, content, templates }`
`cfg.secrets = { telegramToken, telegramChatId, minimaxApiKey }`
`cfg.paths = { root, home, db, content }`

**Nada del usuario vive en el repo.** `bcaHome()` (`%LOCALAPPDATA%\brand-content-ai` o
`~/.config/brand-content-ai`, movible con `BCA_HOME`) guarda `config.json`, `.env`, la
base y el contenido. `configLocalPath()` hace merge de ese config sobre
`brand-content-ai.config.json`. Una instalacion con `./data` preexistente la sigue usando:
mover la base invalidaria las rutas absolutas de las piezas ya generadas.

**Marcas:** `cfg.brand` ya no es la marca del sistema sino el respaldo para
migrar. La marca real es una fila de `brands` y se pasa explicita a los prompts;
`withBrand(cfg, brand)` arma la vista de la config con esa marca para el codigo
que todavia lee `cfg.brand`.
`cfg.minimax = { baseUrl, anthropicVersion, maxTokens, timeoutMs, pricing }`

### `src/lib/store.mjs`

```js
openStore(dbPath) -> Store

// items
store.upsertItem({ id, scheduled_for, format, language?, angle, message, status? }) -> item
store.getItem(id) -> item | null
store.listItems({ status?, from?, to?, limit? }) -> item[]
store.setStatus(id, status, patch?) -> item
   // patch admite: brief, asset_path, preview_path, error, feedback
store.bumpRevision(id, feedback) -> nuevoNumeroDeRevision
   // archiva la revision actual, resetea el item a 'planned' y limpia assets
store.listRevisions(id) -> revision[]

// knowledge
store.putKnowledge(repoId, headSha, digest, facts?)
store.getKnowledge(repoId) -> { repo_id, head_sha, digest, facts, updated_at } | null
store.allKnowledge() -> knowledge[]

// kv + bitacora
store.get(k, fallback?) -> string
store.set(k, v)
store.logRun({ kind, itemId?, model?, costUsd?, ms?, ok?, detail? })
store.costSummary(sinceDays?) -> [{ kind, n, usd }]

// bitacora por pieza (lo que se ve en consola, con nivel)
store.addLog(itemId, nivel, texto)          // nivel: info | aviso | error
store.logsDe(itemId, { desde?, limit? })    // -> [{ id, nivel, texto, created_at }]
store.pruneLogs(itemId, keep?)              // deja las ultimas `keep` (600)
```

**Formatos:** el pipeline decide por `formats.<id>.kind` (`text` | `still` |
`slides` | `motion`), no por el nombre del formato. Agregar "story" o "reel" es
una entrada en `brand-content-ai.config.json`, sin tocar codigo. `esVertical(formatCfg)`
activa las reglas de safe area para los lienzos mas altos que anchos.

Estados validos de un item, en orden:
`planned -> briefed -> building -> built -> delivered -> approved | rejected`

### `src/lib/modelo.mjs`

```js
runModelo(prompt, {
  model?, systemPrompt?, timeoutMs?,
  files?: Record<label, contenido>,   // inlinado en el prompt; no hay tools de filesystem
  apiKey?, baseUrl?, anthropicVersion?, maxTokens?,   // overrides de cfg.minimax
})
  -> {
    text, costUsd,        // null si no hay pricing para el modelo
    ms, model, sessionId,
    inputTokens, outputTokens,
    cacheReadTokens,      // tokens servidos desde cache: la API los cuenta aparte
    stopReason,           // "end_turn" | "max_tokens" | "tool_use" | ...
    raw                   // payload completo
  }

runModeloJSON(prompt, opts)   // igual, mas { data } ya parseado; reintenta 1 vez

// Conversacion: recibe el historial ([{ role, content }], el ultimo del usuario)
// y devuelve lo mismo que runModelo mas `mensajes` con el turno del asistente
// agregado, listo para seguir. Mismo costo, reintentos y timeout.
runModeloChat(mensajes, opts)

// Bloques de imagen para el contenido de un mensaje, y el historial sin ellos
// (marcador de texto en su lugar): una foto sirve en la vuelta en que se manda.
imagenPng(bufferOBase64, mediaType?) -> { type: "image", source: {...} }
sinImagenes(mensajes) -> mensajes

// El contenido de un mensaje del usuario con archivos inlineados adelante. Con
// { cache: true } devuelve dos bloques y el de archivos lleva
// cache_control: { type: "ephemeral" } — para conversaciones que repiten un
// prefijo largo. Si el endpoint lo rechaza (400 que lo nombra), el wrapper
// reintenta una vez sin la marca; nunca falla una llamada por eso.
conArchivos(prompt, files, { cache? }) -> string | [{ type: "text", text, cache_control? }]

// Ante 429 / 5xx / cortes de red, runModelo reintenta solo (opts.retries, 2 por
// defecto) respetando `retry-after`. El timeout NO se reintenta.
extractJSON(text) -> any | undefined
ModeloError                    // .status, .body, .cause
```

La API Anthropic-compatible de MiniMax NO expone herramientas de filesystem:
el modelo no puede leer ni escribir archivos. Quien necesita que vea archivos (frame.md, reference.html,
el repo para sync) los inlinia en el prompt via `opts.files` y el wrapper los
envuelve en bloques `<<<BCA_FILE path="...">>>` ... `<<<BCA_END_FILE>>>`.

**Costo:** se calcula localmente con
`cfg.minimax.pricing[<model>] = { input, output, cacheRead? }` (USD por 1K tokens)
a partir de `usage.input_tokens`, `usage.output_tokens` y
`usage.cache_read_input_tokens`. Sin `cacheRead` declarado, los tokens cacheados
se cobran al precio de entrada. Si el modelo no tiene pricing configurado,
`costUsd` queda en `null` y `npm run costs` lo cuenta como 0.

## Modulos del pipeline

### `src/lib/brand.mjs`

```js
createBrand(cfg, store, { url?, name?, colors?, hints?, id?, log? })
  -> { brand, costUsd, warnings }
reviseBrand(cfg, store, id, feedback, { log? })
  -> { brand, revision, costUsd, warnings }
materializeBrand(cfg, store, id, { log?, force? })  -> projectDir
ensureDefaultBrand(cfg, store, { log? })            -> brand   // migra la config vieja
renderFrameMd(brand) -> string
renderReferenceComposition(brand) -> string
normalizePalette(p, warnings) / contrast(a,b) / forzarContraste(c, fondo, objetivo)
```

**El reparto es deliberado:** el MODELO decide los valores (paleta, familias,
voz, frases prohibidas) y el CODIGO arma el `frame.md` y el proyecto base. Dejar
que el modelo escriba las 300 lineas de YAML daba sistemas de diseno distintos
entre si y rompia el pipeline cuando se olvidaba una clave.

**Contraste:** la paleta se corrige antes de guardarse (`ink` sobre `bg` >= 4.5,
`accent` sobre `bg` >= 3). El linter de HyperFrames falla las piezas por
contraste; arreglarlo una vez en la marca evita que cada pieza pelee lo mismo.

**Proyecto base:** `<projectsDir>/_marcas/<id>/` con `frame.md`,
`hyperframes.json`, `assets/fonts/brand.css` (base64) y
`.bca/reference.html`. `ensureProject` lo clona por pieza.

### `src/lib/layouts.mjs`

```js
LAYOUT_IDS                                  // hero, statement, stat, split, cues, steps, cta
layoutCatalog() -> string                   // para el prompt del planificador
validateSlots(id, slots) -> string[]        // problemas; vacio si esta bien
renderLayout(id, { brand, width, height, scene, total, slots, vertical }) -> html
tonos(palette, register) -> { ground, surface, ink, muted, hint, line, accent, accentText, onAccent }
ajustarTexto(text, { maxWidth, maxPx, minPx, maxLines, ... }) -> { px, lines }
pantallaCompleta(width, height) -> boolean  // 9:16 o mas alto: safe area de la app
sampleSlots(id) -> slots de muestra
```

Los layouts NO traen colores ni familias propias: todo sale del `brand`
(paleta normalizada + fuentes) y las medidas del lienzo (1u = 1% del ancho,
el `cqw` de frame.md). El registro (dark/light) por escena invierte tierra y
tinta y re-deriva los intermedios con contraste garantizado (`tonos`). El
texto se parte en lineas explicitas sin romper palabras (`ajustarTexto`), y
el HTML cumple HARD_RULES: timeline unica pausada, gsap.set inmediato, solo
transforms/opacity, una regla que crece durante todo el hold, ids estables,
marcador de fuentes. Un layout nuevo se agrega aca y aparece solo en el
catalogo del planificador.

### `src/lib/site.mjs`

```js
readSite(url, { maxPages?, timeoutMs?, fetchImpl?, log? })
  -> { url, host, title, description, pages, text, headings, colors, fonts, links }
getPage(url, opts) / extractColors(css) / extractFonts(css) / textoDeScripts(html)
```

Una SPA sirve un HTML vacio: el texto se busca primero en el payload de
hidratacion y despues en el bundle JS, filtrando los mensajes del framework.
Nunca lanza por una pagina interna que falle.

### `src/lib/fonts.mjs`

```js
buildFontCss([{ family, weights }], { cacheDir?, timeoutMs?, fetchImpl?, log? })
  -> { css, families, bytes, cached }
familyExists(family, opts) -> boolean
```

Pide el CSS a Google Fonts con user-agent de navegador (si no, manda TTF),
descarga los `.woff2` de los subsets latin/latin-ext y los reescribe como data
URI. El render no tiene red: la fuente tiene que viajar dentro del HTML.

### `src/lib/knowledge.mjs`

```js
export async function syncRepo(cfg, store, repoConfig, { log } = {}) -> {
  repoId, headSha, skipped, digestChars, costUsd
}
export async function syncAll(cfg, store, { log, force } = {}) -> resultados[]
export function knowledgeContext(store, { maxChars = 12000 } = {}) -> string
```

- `headSha` sale de `git -C <path> rev-parse HEAD`. Si el sha guardado coincide y
  no hay `force`, devolver `skipped: true` sin llamar al modelo.
- El digest lo escribe el backend MiniMax (`cfg.models.digest`) leyendo los
  archivos del repo que matcheen `repoConfig.include` (globs), inlinados en el
  prompt via `opts.files`. Tapas: `MAX_INLINE_FILES` archivos y
  `MAX_INLINE_BYTES` bytes (definidas en `knowledge.mjs`). El digest debe
  responder: que es el proyecto, que problemas resuelve, sus capacidades
  concretas y numeros citables.
- `facts` es un array de hechos verificables y citables en marketing
  (`{ claim, source }`), extraidos del repo — nunca inventados.
- `knowledgeContext` concatena los digests para inyectarlos como contexto de
  marca en los prompts de planificacion y generacion, recortando a `maxChars`.

### `src/lib/calendar.mjs`

```js
export async function planCalendar(cfg, store, { days = 14, from, log } = {}) -> {
  created: item[], costUsd
}
```

- Pide al backend un calendario respetando `cfg.calendar.itemsPerWeek` y `mix`.
- Contexto: `knowledgeContext(store)` + `cfg.brand`.
- **No repetir angulos ya usados**: pasarle los `angle` de los items existentes.
- Cada item: `{ scheduled_for, format, language, angle, message }`.
- `id` = `${scheduled_for}-${slugify(angle)}`; persistir con `store.upsertItem`.
- Validar que `format` este en `cfg.formats` y habilitado; descartar el resto.

### `src/lib/generate.mjs`

```js
export async function generateItem(cfg, store, itemId, { log } = {}) -> {
  itemId, assetPath, previewPath, costUsd
}
// Igual que generateItem, pero reintenta los fallos que mejoran solos
// (RETRIABLE_PHASES: layout, check, repair, compose, snapshot).
// Tope: limits.retriesPerItem.
export async function generateWithRetry(cfg, store, itemId, { log, retries } = {})
export async function generatePending(cfg, store, { limit, brandId, log } = {}) -> resultados[]
export const RETRIABLE_PHASES   // que fases vale la pena repetir
```

**`check` y su reparacion.** Es una conversacion (`runModeloChat`), no una
llamada suelta por parche:

- `summarizeCheck(res)` devuelve `{ findings, bloqueantes, secundarios, texto }`.
  Bloqueante = severidad `error`, el mismo criterio que hace fallar el check.
  `firmaDe(finding)` = `codigo|file|selector|t`: lo que identifica a UN error
  aunque el resto del report cambie.
- `buildRepairPrompt({ plan, check, turn, maxTurns, historia })` abre la
  conversacion: "que bloquea" (arreglar esto y nada mas), "que es cosmetico" (el
  check pasa igual, agrupado por regla), y la lista de archivos con los que
  tienen error bloqueante marcados. Los archivos van con `conArchivos(..., {
  cache: true })`.
- Cada vuelta: se escriben los archivos, `applyFonts`, `hyperframes check
  --json`, y `buildRepairFollowUp({ plan, check, previo, ... })` le dice que
  sobrevivio (el arreglo no sirvio), que aparecio y que se resolvio. Si el modelo
  no devolvio archivos no se corre el check (daria lo mismo): se le reclama.
- Topes: `limits.repairTurns` (4) y `limits.repairTokenBudget` (600k).
  Agotarlos falla con fase `check`, reintentable: el intento siguiente reusa las
  escenas y `.bca/check-history.json` (vistas por firma).
- Escalada por firma repetida (`VISTAS_PARA_RECOMPONER = 3`,
  `VISTAS_PARA_CORTAR = 4`): vista 2 se repara diciendo que sobrevivio; vista 3
  se descarta la escena, se anota en `.bca/layout-notes.json` y se recompone
  desde el brief con `writeCompositions` (misma maquinaria que la fase
  `layout`; la conversacion se reinicia); vista 4 corta con `check-estancado`,
  que **no** esta en `RETRIABLE_PHASES` a proposito: el brief pide algo que esa
  escena no puede cumplir y eso lo decide una persona.

Todo lo que se dice de una pieza va por `bitacoraDe(store, itemId, log)`: a la
consola y a la tabla `logs` con nivel (`error` = bloqueante, `aviso` =
cosmetico, `info`), que el panel muestra en vivo y despues.

Un job cuyo `pid` ya no existe no bloquea a nadie (`jobAlive`): el guardia de
"ya se esta generando" mira el proceso, no solo el latido.

Fases, marcando estado en cada una:
1. `briefed` — el backend escribe el brief (copy por escena/slide, cues, paleta).
   Guardar el JSON completo en `store.setStatus(id, 'briefed', { brief })`.
   Si el item tiene `feedback` (viene de un rechazo), el brief DEBE atenderlo
   explicitamente; incluirlo en el prompt.
2. `building` — materializar el entregable.
   - `text`: escribe `content/<id>/post.md`. Sin render.
   - `image` / `carousel` / `video`: proyecto HyperFrames bajo
     `cfg.hyperframes.projectsDir`. Reusar el proyecto de referencia
     (`cfg.hyperframes.referenceProject`) como fuente del `frame.md` de marca —
     copiarlo, no regenerarlo.
   - `compose` es UNA llamada JSON (`buildLayoutPlanPrompt` /
     `parseLayoutPlan`): el modelo elige un layout de `layouts.mjs` por
     escena y rellena sus huecos con el copy del brief; `renderLayout` escribe
     el HTML. El modelo no escribe HTML de escena. Los layouts son agnosticos
     de marca: paleta y tipografias salen del `brand`, las medidas del lienzo.
     El plan queda en `.bca/layout-plan.json`.
   - `repair` (del linter o de la revision visual) si edita HTML: corre contra
     el backend con los archivos inlinados via `opts.files` (el modelo NO
     tiene tools de filesystem) y parsea la respuesta con `extractCompositions`.
     Lo que se inlinea va SIN las fuentes en base64 (`stripEmbeddedFonts`,
     marcador `FONT_MARKER`) y despues de cada reparacion se vuelve a llamar
     `applyFonts`: mandar los 140 KB de base64 hacia que el modelo intentara
     transcribirlos y se cortara a mitad.
   - Revision visual (`reviewAndRepair`), despues de que el check pasa: se
     fotografian todas las escenas (`snapshot --at`), `buildReviewMessage`
     manda cada foto (`imagenPng`) con el copy esperado al modelo de vision
     (`cfg.models.review`) y `parseReview` normaliza el veredicto. Si hay
     observaciones, `buildVisualRepairPrompt` + la foto de esa escena van a la
     conversacion de reparacion; lo reescrito vuelve a pasar por `checkAndRepair`
     y se fotografia de nuevo. Hasta `limits.reviewTurns` (2); agotarlas NO
     falla la pieza. Las imagenes viajan solo en el mensaje de su vuelta:
     `sinImagenes` deja un marcador en el historial. Los stills se entregan
     desde la ultima tanda de fotos.
   - Renderizar con `npx hyperframes@<cliVersion>`; para imagen/carrusel usar
     `snapshot`, para video `render`.
3. `built` — `asset_path` al entregable y `preview_path` a una imagen (para
   Telegram; en video, un frame representativo).

Ante error: `store.setStatus(id, 'planned', { error })` y relanzar. Nunca dejar
un item colgado en `building`.

**Costos:** cada fase anota lo suyo (`brief`, `compose`, `plan`, `digest`). La
fila `render` NO repite el total de la pieza — hacerlo hacia que `npm run costs`
sumara todo dos veces.

### `src/lib/auth.mjs`

```js
crearCuenta(store, { email, password, name, role })   // la primera es siempre owner
autenticar(store, email, password) -> user | null
firmarSesion(secreto, userId) / usuarioDeSesion(store, secreto, cookie)
crearInvitacion(store, { email?, role, invitedBy }) / revisarInvitacion / aceptarInvitacion
hashPassword / verifyPassword / validarPassword / esUltimoOwner
```

- **scrypt** para las contrasenas (salt por usuario, `salt$hash`) y HMAC para la
  cookie. Sin tabla de sesiones: la cookie lleva `userId.vence.firma` y en cada
  request se comprueba que el usuario siga existiendo, asi que borrar a alguien
  le corta el acceso al instante.
- **Sin correo saliente:** la invitacion es un link de un solo uso que vence a
  los 7 dias. Si la invitacion trae email, ese email manda sobre lo que escriba
  quien la usa.
- **Roles:** `owner` (ajustes, invitar, sacar, borrar marcas) y `member` (todo
  lo demas). No se puede sacar al ultimo owner.

### `src/lib/web.mjs` + `views.mjs` + `ui.mjs`

```js
startWeb(cfg, store, handlers, { port?, host?, log? }) -> Promise<http.Server>
```

- `web.mjs` rutea, valida y lanza trabajo en background; `views.mjs` son
  funciones puras que devuelven HTML; `ui.mjs` tiene el layout, el CSS y el
  unico JS del panel.
- **Handlers que espera:** `generate(id, { entregar })`, `entregar(id)`,
  `generateAll(limit, brandId)`, `plan(dias, from, brandId)`,
  `reject(id, motivo)`, `crearMarca(opts)`, `revisarMarca(id, feedback)`,
  `sincronizar(brandId)`, `rescue()`. Los que faltan degradan con un mensaje,
  no con un 500.
- **`building` no significa "en curso".** Es "alguien la empezó": si el proceso
  murió, la fila queda igual. `estadoDe(item)` distingue `running` / `stale`
  (hay job, sin latido) / `orphan` (building sin job) y `detenidosDe(items)`
  resuelve eso de una para toda una pantalla. Las vistas pintan **detenido** en
  esos casos, con desde cuándo, en qué fase y el último fallo real
  (`store.ultimoFallo`). Decir "generando" ahí hace esperar por algo que no va
  a pasar.
- **Revisión anterior:** regenerar limpia `items.asset_path`, pero el
  entregable de la revisión previa sigue en disco y se sirve en
  `/asset/<id>/r<N>`. La pieza lo muestra como "lo último que salió bien" en vez
  de decir que no hay nada.
- **Marca activa:** cookie `bca_marca`; sin ella, `store.defaultBrand()`.
- **Tema:** cookie `bca_tema` (auto | claro | oscuro) — la lee el server para
  servir el HTML ya pintado y que no haya parpadeo. `auto` deja mandar a la
  paleta de la marca activa; `claro`/`oscuro` la ignoran a proposito.
- **Tematizacion:** `pagina()` emite los custom properties a partir de
  `marcaActiva.palette` y deriva el resto con `color.mjs`. Es seguro porque
  `normalizePalette` ya garantizo los contrastes WCAG antes de guardar; los
  colores de estado se fuerzan contra el `bg` de cada marca.
- **Nombres de clase:** `views.mjs` es duenio del HTML y `ui.mjs` del CSS, asi
  que una clase nueva en `ui.mjs` no puede pisar una que las vistas ya usan.
  Paso con `.barra` (barra de progreso) contra el header nuevo: la segunda
  regla le imponia `height:3px` y lo aplastaba. El header se llama `.cabecera`.
- **Acceso:** tres modos, en orden — (1) hay cuentas: login con email; (2) no
  hay cuentas pero si `BCA_PANEL_PASSWORD`: clave unica, para instalaciones
  viejas; (3) no hay nada: primera corrida, todo redirige a `/setup`.
  `startWeb` se niega a escuchar fuera de 127.0.0.1 si no hay ninguna de las
  dos. Los POST exigen mismo origen.
- **Tour:** `/empezar` calcula sus pasos del estado real (hay key, hay marca,
  hay hechos, hay pieza). El login manda ahi mientras falte alguno, salvo que
  el kv tenga `ui:tour-visto = "1"` — que gana sobre el calculo, porque si no
  el asistente volvia solo al borrar una marca de prueba.
- **Acciones caras:** `/confirmar/generar` y `/confirmar/plan` son GET que
  muestran alcance y costo estimado (`store.costPorFormato()`, promedio real
  del historial) antes del POST que ejecuta. `generar-pendientes` trabaja
  **solo sobre la marca activa** y entrega a Telegram solo lo que genero esa
  corrida.
- **Borrado de archivos:** `/marcas/<id>/borrar` puede borrar las carpetas de
  una marca, pero solo las que caen dentro de `hyperframes.projectsDir` o
  `paths.content`. Un `project_dir` que apunta afuera se ignora, no se borra.

### `src/lib/telegram.mjs`

```js
export async function sendMessage(cfg, text, { chatId, replyMarkup } = {}) -> msg
export async function sendPhoto(cfg, filePath, { caption, chatId } = {}) -> msg
export async function sendVideo(cfg, filePath, { caption, chatId } = {}) -> msg
export async function sendDocument(cfg, filePath, { caption, chatId } = {}) -> msg
export async function deliverItem(cfg, store, itemId) -> void
export async function runBot(cfg, store, handlers, { log, signal } = {}) -> void
```

- **Long polling** (`getUpdates` con `timeout=25`), nunca webhook: el sistema
  corre en una PC local sin IP publica. Guardar el offset en
  `store.set('tg:offset', n)` para no reprocesar al reiniciar.
- Subida de archivos con `FormData` + `Blob` nativos.
- `deliverItem` envia el asset segun formato y pasa el item a `delivered`.
- Comandos que `runBot` debe entender:
  - `/hoy` — que hay para hoy
  - `/pendientes` — items sin entregar
  - `/plan [dias]` — replanificar
  - `/generar <id>` — forzar generacion
  - `/ok <id>` — aprobar
  - `/no <id> <motivo>` — rechazar; llama a `store.bumpRevision` y regenera
  - `/costos` — resumen de gasto
  - `/ayuda`
- **Solo responder a `cfg.secrets.telegramChatId`.** Cualquier otro chat se
  ignora en silencio: el bot no debe obedecer a desconocidos.
