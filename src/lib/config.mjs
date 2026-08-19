// Carga de configuracion y secretos.
//
// brand-content-ai.config.json -> decisiones del producto (versionable, sin secretos)
// .env                         -> secretos (git-ignored)
//
// El proyecto se llamaba "adsai" y todo lo que escribia en disco llevaba ese
// nombre. Al renombrarlo no se rompe ninguna instalacion: los nombres viejos se
// detectan y se migran solos la primera vez (migrarNombres), y las variables de
// entorno ADSAI_* se siguen leyendo como respaldo de las BCA_* (env).

import { existsSync, readFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** El nombre del paquete: da nombre al archivo de config, a la base y a la carpeta. */
export const PAQUETE = "brand-content-ai";

const CONFIG_JSON = `${PAQUETE}.config.json`;
const CONFIG_LOCAL_JSON = `${PAQUETE}.config.local.json`;
const DB_FILE = `${PAQUETE}.db`;

// Como se llamaba cada cosa antes del rename. Solo se usa para migrar, asi que
// estos strings tienen que quedar tal cual: son los nombres viejos, no un texto
// que haya que actualizar junto con el resto.
const VIEJO = {
  config: "adsai.config.json",
  configLocal: "adsai.config.local.json",
  db: "adsai.db",
  home: "adsai",
};

let cached = null;

/**
 * Una variable de entorno del producto, por su nombre sin prefijo.
 *
 * Se prueba BCA_<X> y despues ADSAI_<X>: un .env escrito antes del rename sigue
 * funcionando sin que nadie tenga que editarlo.
 */
export function env(nombre) {
  return process.env[`BCA_${nombre}`] ?? process.env[`ADSAI_${nombre}`] ?? "";
}

/**
 * Renombra en disco lo que quedo con el nombre viejo.
 *
 * Solo actua cuando el nombre viejo existe y el nuevo todavia no: es idempotente
 * y nunca pisa nada. Si el renombrado falla (permisos, archivo abierto) se
 * devuelve la ruta vieja y se sigue trabajando con ella — migrar es una
 * comodidad, no un requisito para arrancar.
 */
function migrar(viejo, nuevo) {
  // Nada que migrar: una instalacion nueva estrena el nombre nuevo.
  if (existsSync(nuevo) || !existsSync(viejo)) return nuevo;
  try {
    renameSync(viejo, nuevo);
    return nuevo;
  } catch {
    return viejo;
  }
}

/**
 * La carpeta donde cada proyecto de HyperFrames guarda lo nuestro: la
 * composicion de referencia, el hash del brief, las notas de layout.
 */
export const META_DIR = ".bca";
const META_DIR_VIEJO = ".adsai";

/**
 * Una ruta dentro de esa carpeta, prefiriendo la que ya exista.
 *
 * Los proyectos generados antes del rename tienen la carpeta con el nombre
 * viejo y estan renderizados: renombrarsela no aporta nada y podria romper una
 * pieza terminada. Un proyecto nuevo estrena el nombre nuevo.
 */
export function rutaMeta(dir, ...partes) {
  const nueva = join(dir, META_DIR, ...partes);
  if (existsSync(nueva)) return nueva;
  const vieja = join(dir, META_DIR_VIEJO, ...partes);
  return existsSync(vieja) ? vieja : nueva;
}

/**
 * Olvida la config cacheada.
 *
 * Existe desde que los ajustes se pueden cambiar desde el panel: al guardar una
 * API key nueva hay que recargar, o el wrapper del modelo seguiria usando la
 * anterior hasta reiniciar el proceso.
 */
export function reloadConfig() {
  cached = null;
}

export function loadConfig() {
  if (cached) return cached;

  const configPath = migrar(join(ROOT, VIEJO.config), join(ROOT, CONFIG_JSON));
  if (!existsSync(configPath)) {
    throw new Error(`falta ${CONFIG_JSON} en ${ROOT}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));

  // Lo de ESTA maquina (rutas de repos, donde viven los proyectos) vive FUERA
  // del proyecto por defecto: en %LOCALAPPDATA%\brand-content-ai en Windows, en
  // ~/.config/brand-content-ai en el resto. Asi la carpeta del codigo no guarda nada tuyo
  // — ni siquiera sin querer, al comprimirla o compartirla — y actualizar el
  // proyecto no pisa tu configuracion.
  const localPath = configLocalPath();
  if (localPath) {
    mergeProfundo(cfg, JSON.parse(readFileSync(localPath, "utf8")));
    cfg.paths_localConfig = localPath;
  }

  // Mismo criterio para los secretos: primero donde vive tu configuracion,
  // despues el .env del proyecto (que sigue funcionando, para quien lo prefiera
  // o para un contenedor que lo monta ahi).
  for (const archivo of envCandidatos()) {
    if (existsSync(archivo)) {
      loadDotEnv(archivo);
      break;
    }
  }

  // Una ruta relativa en la config es relativa al proyecto, no al directorio
  // desde donde se ejecuto el comando.
  if (cfg.hyperframes?.projectsDir) {
    cfg.hyperframes.projectsDir = resolve(ROOT, cfg.hyperframes.projectsDir);
  }
  if (cfg.hyperframes?.referenceProject) {
    cfg.hyperframes.referenceProject = resolve(ROOT, cfg.hyperframes.referenceProject);
  }
  if (cfg.hyperframes?.brandsDir) {
    cfg.hyperframes.brandsDir = resolve(ROOT, cfg.hyperframes.brandsDir);
  }

  // Los datos van a tu carpeta, no a la del codigo: una instalacion nueva no
  // ensucia el repo ni corre riesgo de que alguien comprima el proyecto y se
  // lleve la base con las API keys adentro. Las instalaciones que ya tenian
  // ./data siguen usandola: mover la base romperia las rutas absolutas de las
  // piezas ya generadas.
  const dataRoot = existsSync(join(ROOT, "data")) ? ROOT : bcaHome();
  cfg.paths = {
    root: ROOT,
    home: bcaHome(),
    db: migrarBase(join(dataRoot, "data")),
    content: join(dataRoot, "content"),
  };

  cfg.secrets = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    minimaxApiKey: env("MINIMAX_API_KEY"),
  };

  // minia: defaults razonables si el archivo de config no trae el bloque.
  // El secreto NO va aca (vive en cfg.secrets); solo configuracion operativa.
  //
  // baseUrl apunta al endpoint Anthropic-compatible de MiniMax, no al nativo:
  // el wrapper le pega a <baseUrl>/messages con la cabecera anthropic-version.
  // Global (keys de minimax.io):  https://api.minimax.io/anthropic/v1
  // China continental (minimaxi): https://api.minimaxi.com/anthropic/v1
  // La key solo autentica en la region donde se compro.
  const envBase = env("MINIMAX_BASE_URL");
  const envMax = Number(env("MINIMAX_MAX_TOKENS"));
  const envTimeout = Number(env("MINIMAX_TIMEOUT_MS"));
  const m = cfg.minimax && typeof cfg.minimax === "object" ? cfg.minimax : {};
  cfg.minimax = {
    baseUrl: envBase || m.baseUrl || "https://api.minimax.io/anthropic/v1",
    anthropicVersion: m.anthropicVersion || "2023-06-01",
    maxTokens: Number.isFinite(envMax) && envMax > 0 ? envMax : Number(m.maxTokens) > 0 ? Number(m.maxTokens) : 8192,
    timeoutMs:
      Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : Number(m.timeoutMs) > 0
          ? Number(m.timeoutMs)
          : 900_000,
    pricing: m.pricing && typeof m.pricing === "object" ? m.pricing : {},
  };

  cached = cfg;
  return cfg;
}

/**
 * Mezcla `extra` sobre `base`, entrando en los objetos y reemplazando el resto.
 * Un array en el archivo local reemplaza al de arriba entero: media lista de
 * repos mezclada con la otra media no es nada que alguien quiera.
 */
function mergeProfundo(base, extra) {
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      mergeProfundo(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/**
 * La base, migrando el nombre viejo si hace falta.
 *
 * SQLite deja dos archivos laterales (-wal y -shm) cuando el proceso no cerro
 * limpio; si se renombra la base sin ellos, se pierden las transacciones que
 * todavia estaban en el log. Por eso se mueven los tres.
 */
function migrarBase(dir) {
  const nueva = join(dir, DB_FILE);
  const vieja = join(dir, VIEJO.db);
  if (existsSync(nueva) || !existsSync(vieja)) return nueva;
  for (const sufijo of ["-wal", "-shm"]) migrar(`${vieja}${sufijo}`, `${nueva}${sufijo}`);
  return migrar(vieja, nueva);
}

/**
 * La carpeta donde viven tus cosas: configuracion local y secretos.
 *
 * Se puede mover con BCA_HOME (util para un servidor o para tener varias
 * instalaciones). Nunca es la carpeta del codigo.
 */
export function bcaHome() {
  const explicito = env("HOME");
  if (explicito) return resolve(explicito);
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || process.env.APPDATA || process.env.USERPROFILE || ROOT
      : process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? ROOT, ".config");
  return migrar(join(base, VIEJO.home), join(base, PAQUETE));
}

/** Nombre anterior. Sigue exportado para no romper a quien ya lo importaba. */
export const adsaiHome = bcaHome;

/** Donde esta tu config local, si existe. El orden es el de la precedencia. */
export function configLocalPath() {
  const candidatos = [
    env("CONFIG"),
    join(bcaHome(), "config.json"),
    // Compatibilidad: instalaciones que la tenian dentro del proyecto.
    migrar(join(ROOT, VIEJO.configLocal), join(ROOT, CONFIG_LOCAL_JSON)),
  ].filter(Boolean);
  return candidatos.find((c) => existsSync(c)) ?? null;
}

function envCandidatos() {
  return [env("ENV_FILE"), join(bcaHome(), ".env"), join(ROOT, ".env")].filter(Boolean);
}

/** Parser minimo de .env: KEY=value, ignora comentarios y comillas envolventes. */
export function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/**
 * La config vista desde una marca: `cfg.brand` pasa a ser la marca que se esta
 * usando, con los mismos nombres que tenia en el archivo de config.
 *
 * Existe para no reescribir cada prompt cuando la marca dejo de ser una
 * constante del archivo y paso a ser una fila de la base. Quien necesite la
 * marca completa (paleta, tipografias, frame.md) la recibe aparte.
 */
export function withBrand(cfg, brand) {
  if (!brand) return cfg;
  return {
    ...cfg,
    brand: {
      ...(cfg.brand ?? {}),
      id: brand.id,
      name: brand.name,
      site: brand.site ?? undefined,
      audience: brand.audience ?? undefined,
      voice: brand.voice ?? undefined,
      nameUsage: brand.nameUsage ?? undefined,
      never: Array.isArray(brand.never) ? brand.never : [],
      languages: Array.isArray(brand.languages) && brand.languages.length ? brand.languages : ["en"],
      languageMix: brand.languageMix ?? undefined,
      defaultLanguage:
        (Array.isArray(brand.languages) && brand.languages[0]) || cfg.brand?.defaultLanguage || "en",
    },
  };
}

/** Fecha local en YYYY-MM-DD (sin depender de UTC, que corre el dia). */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return today(dt);
}

/** Slug estable y seguro para nombre de carpeta. */
export function slugify(s, max = 48) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}
