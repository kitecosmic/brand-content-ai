// El ciclo diario, dentro del contenedor.
//
// En una PC esto lo hacia el programador de tareas de Windows. En el servidor
// no queremos depender de un cron del host: la idea del despliegue es que
// `docker compose up -d` deje el sistema entero funcionando, ciclo incluido.
//
// Es a proposito un proceso aparte del panel y no un temporizador adentro de
// el: la base ya esta pensada para varios procesos (el bot, el ciclo y la CLI
// comparten el estado por SQLite, y generar toma el trabajo con un lock con
// latido), y separarlos hace que una corrida que se cuelga no se lleve puesto
// al panel. Cada corrida es un `cli.mjs run` nuevo, que arranca limpio.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/lib/config.mjs";

const cfg = loadConfig();
const hora = Number(cfg.calendar?.publishHourLocal ?? 9);
const tzConfig = cfg.calendar?.timezone;
const tzProceso = Intl.DateTimeFormat().resolvedOptions().timeZone;

const log = (msg) => console.log(`[ciclo ${new Date().toLocaleString("sv")}] ${msg}`);

/**
 * Si dos zonas marcan la misma hora, son la misma zona para lo que nos importa.
 *
 * Comparar los nombres no sirve: la tzdata tiene alias —America/Buenos_Aires es
 * la forma canonica de America/Argentina/Buenos_Aires— y avisar por eso seria
 * mandar a arreglar algo que ya esta bien. Se miran tres instantes y no uno
 * para que dos zonas que hoy coinciden pero cambian de hora en distinta fecha
 * no pasen por iguales.
 */
function mismaHora(a, b) {
  const momentos = [new Date(), new Date("2026-01-15T12:00:00Z"), new Date("2026-07-15T12:00:00Z")];
  const enZona = (tz, d) => new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "short", timeStyle: "long" }).format(d);
  return momentos.every((d) => enZona(a, d) === enZona(b, d));
}

// La hora de publicacion es hora local, asi que el contenedor tiene que estar
// en la zona correcta o el ciclo corre a destiempo sin que nada falle. Se avisa
// una vez al arrancar en vez de adivinar: cambiar la zona del proceso a
// espaldas de la config solo mueve el problema a las fechas del calendario.
if (tzConfig) {
  try {
    if (!mismaHora(tzProceso, tzConfig)) {
      log(`aviso: el contenedor esta en ${tzProceso} y calendar.timezone dice ${tzConfig} — pone TZ=${tzConfig} en el .env`);
    }
  } catch {
    log(`aviso: calendar.timezone dice ${tzConfig}, que no es una zona horaria conocida — el ciclo usa ${tzProceso}`);
  }
}

let hijo = null;
let cortando = false;
for (const senal of ["SIGTERM", "SIGINT"]) {
  process.on(senal, () => {
    cortando = true;
    if (hijo) hijo.kill("SIGTERM");
    log("cerrando");
    process.exit(0);
  });
}

/** La proxima vez que el reloj local marque la hora de publicacion. */
function proximaCorrida() {
  const ahora = new Date();
  const t = new Date(ahora);
  t.setHours(hora, 0, 0, 0);
  if (t <= ahora) t.setDate(t.getDate() + 1);
  return t;
}

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Una corrida. Nunca tira: un ciclo que falla —la API caida, una pieza rota— no
 * puede terminar con el proceso, porque entonces manana tampoco se genera nada.
 */
function correr() {
  return new Promise((resolve) => {
    const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    hijo = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "run"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: "inherit",
      env: process.env,
    });
    hijo.on("error", (err) => {
      log(`no se pudo lanzar la corrida: ${err.message}`);
      hijo = null;
      resolve();
    });
    hijo.on("close", (code) => {
      log(code === 0 ? "corrida terminada" : `corrida terminada con codigo ${code}`);
      hijo = null;
      resolve();
    });
  });
}

log(`ciclo diario activo — ${String(hora).padStart(2, "0")}:00 (${tzProceso})`);

// Util para probar el despliegue sin esperar a la hora, y para el primer dia de
// una instalacion nueva: con CICLO_AL_ARRANCAR=1 genera apenas levanta.
if (process.env.CICLO_AL_ARRANCAR === "1") {
  log("CICLO_AL_ARRANCAR=1: corriendo ahora");
  await correr();
}

while (!cortando) {
  const cuando = proximaCorrida();
  const faltan = cuando - Date.now();
  const horas = Math.floor(faltan / 3_600_000);
  const min = Math.round((faltan % 3_600_000) / 60_000);
  log(`proxima corrida: ${cuando.toLocaleString("sv")} (en ${horas}h ${min}m)`);
  await dormir(faltan);
  if (cortando) break;
  log("arrancando: sync, plan, generate, deliver");
  await correr();
}
