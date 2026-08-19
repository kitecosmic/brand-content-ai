// Punto de entrada del contenedor del panel.
//
// Existe por una sola razon: `bot` se niega a arrancar sin Telegram y `web` no,
// y cual de los dos corresponde no se sabe hasta leer los ajustes guardados en
// la base — que es donde termina el token cuando lo cargas desde el panel, no
// en el .env. Un `command:` fijo en el compose obligaria a editarlo el dia que
// conectas Telegram, y a reiniciar en bucle hasta entonces.
//
// Asi que aca se mira el estado real y se delega en la CLI de siempre. No hay
// logica de negocio: se elige el comando y se importa `src/cli.mjs`, que corre
// su `main()` al ser importado y ve el argv que le dejamos preparado.

import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/lib/config.mjs";
import { openStore } from "../src/lib/store.mjs";
import { aplicarAjustes, telegramConfigurado } from "../src/lib/settings.mjs";

const log = (...a) => console.log(...a);

// Los ajustes del panel mandan sobre el entorno, asi que hay que volcarlos
// antes de preguntar si Telegram esta configurado.
const store = openStore(loadConfig().paths.db);
aplicarAjustes(store);
store.close?.();

const cfg = loadConfig();
const conTelegram = telegramConfigurado(cfg);

if (!cfg.secrets.minimaxApiKey) {
  log("aviso: falta la API key de MiniMax — el panel levanta igual y la cargas en Ajustes.");
}
log(
  conTelegram
    ? "arranque: bot de Telegram + panel (el bot levanta el panel en el mismo proceso)"
    : "arranque: panel (Telegram sin configurar — se puede conectar despues desde Ajustes)",
);

// Host y puerto solo si el entorno los pide. En el compose de produccion no se
// definen: el contenedor comparte la red del host, el panel escucha en
// 127.0.0.1 como en cualquier instalacion, y sigue valiendo la regla de que no
// se publica solo. PANEL_HOST existe para el caso contrario — una red de Docker
// con el puerto publicado — donde escuchar en loopback lo dejaria inalcanzable.
const argv = [conTelegram ? "bot" : "web"];
if (process.env.PANEL_HOST) argv.push("--host", process.env.PANEL_HOST);
if (process.env.PANEL_PORT) argv.push("--port", process.env.PANEL_PORT);

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
process.argv = [process.argv[0], cli, ...argv];
await import(new URL("../src/cli.mjs", import.meta.url).href);
