// Ajustes que se pueden tocar desde el panel en vez de editar el .env.
//
// Por que existe: pedirle a alguien que edite un archivo por SSH para cambiar
// una API key es la forma mas rapida de que el producto no se use. Los valores
// viven en la base (tabla kv, con prefijo) y se vuelcan a `process.env` al
// arrancar, asi el resto del codigo sigue leyendo `process.env` como siempre.
//
// Precedencia: lo que guardaste en el panel MANDA sobre el .env. Si fuera al
// reves, cambiar una clave desde la interfaz no tendria efecto y no habria
// forma de darse cuenta. Cuando un valor esta en los dos lados, la pantalla de
// ajustes lo dice.
//
// Los secretos quedan en texto plano en la base, igual que estaban en el .env:
// cifrarlos sin un secreto externo solo agrega ceremonia. Lo que si se cuida es
// que no salgan de la maquina — nunca se renderiza el valor completo.

import { reloadConfig } from "./config.mjs";

const PREFIJO = "cfg:";

/**
 * Como se llamaba esta variable antes del rename del producto.
 *
 * Un .env escrito con ADSAI_* tiene que seguir viendose en la pantalla de
 * ajustes como "viene del .env"; si no, diria "sin definir" para una key que
 * en realidad esta funcionando.
 */
function aliasViejo(nombre) {
  return nombre.startsWith("BCA_") ? `ADSAI_${nombre.slice(4)}` : nombre;
}

// Lo que traia el entorno ANTES de volcar los ajustes de la base. Se guarda
// para poder decirle a quien mira la pantalla "esto viene del .env" — una vez
// aplicados, process.env ya no distingue quien puso que.
let entornoOriginal = null;

/**
 * Los ajustes que el panel deja tocar. `env` es la variable que el resto del
 * codigo lee; `clave` es como se guarda en la base.
 */
export const CAMPOS = [
  {
    clave: "minimax_api_key",
    env: "BCA_MINIMAX_API_KEY",
    grupo: "modelo",
    label: "API key de MiniMax",
    secreto: true,
    requerido: true,
    ayuda: "platform.minimax.io → API Keys. Sin esto no se genera nada.",
  },
  {
    clave: "minimax_base_url",
    env: "BCA_MINIMAX_BASE_URL",
    grupo: "modelo",
    label: "Endpoint",
    secreto: false,
    // Nadie que empieza tiene que ver esto: el default sirve para el 99% y
    // preguntarlo en la primera pantalla es pedirle una decision a alguien que
    // todavia no sabe que existe la pregunta.
    avanzado: true,
    placeholder: "https://api.minimax.io/anthropic/v1",
    ayuda: "Solo si tu key es de China continental: https://api.minimaxi.com/anthropic/v1",
  },
  {
    clave: "telegram_bot_token",
    env: "TELEGRAM_BOT_TOKEN",
    grupo: "telegram",
    label: "Token del bot",
    secreto: true,
    ayuda: "Opcional. Hablale a @BotFather → /newbot. Sin esto, el contenido se ve solo en el panel.",
  },
  {
    clave: "telegram_chat_id",
    env: "TELEGRAM_CHAT_ID",
    grupo: "telegram",
    label: "Chat ID",
    secreto: false,
    placeholder: "123456789",
    ayuda: "El bot solo obedece a este chat. Se saca de api.telegram.org/bot<TOKEN>/getUpdates",
  },
  {
    clave: "panel_password",
    env: "BCA_PANEL_PASSWORD",
    grupo: "panel",
    label: "Clave unica (modo viejo)",
    secreto: true,
    avanzado: true,
    ayuda:
      "Solo para instalaciones que venian con una clave compartida. Si hay cuentas creadas se ignora: cada persona entra con su email.",
  },
  {
    clave: "ffmpeg",
    env: "BCA_FFMPEG",
    grupo: "panel",
    label: "Ruta de ffmpeg",
    secreto: false,
    avanzado: true,
    placeholder: "ffmpeg",
    ayuda: "Solo si no esta en el PATH. Se usa para el frame de preview de los videos.",
  },
];

export const GRUPOS = [
  { id: "modelo", titulo: "Modelo", detalle: "El backend que escribe y compone. Es lo unico imprescindible." },
  { id: "telegram", titulo: "Telegram", detalle: "Opcional: entrega y control remoto. El sistema funciona sin esto." },
  { id: "panel", titulo: "Panel", detalle: "Acceso y herramientas locales.", soloAvanzado: true },
];

export function campoPorClave(clave) {
  return CAMPOS.find((c) => c.clave === clave) ?? null;
}

/** Lo guardado en la base, sin tocar el entorno. */
export function leerAjustes(store) {
  const out = {};
  for (const c of CAMPOS) {
    const v = store.get(`${PREFIJO}${c.clave}`, null);
    if (v !== null && v !== undefined && String(v) !== "") out[c.clave] = String(v);
  }
  return out;
}

/**
 * Vuelca los ajustes de la base a `process.env` y recarga la config.
 *
 * Se llama al arrancar cualquier comando: a partir de ahi, el wrapper del
 * modelo, Telegram y el panel leen los valores nuevos sin saber que existe
 * esta capa.
 */
export function aplicarAjustes(store) {
  if (!entornoOriginal) {
    entornoOriginal = Object.fromEntries(
      CAMPOS.map((c) => [c.env, process.env[c.env] ?? process.env[aliasViejo(c.env)] ?? ""]),
    );
  }
  const guardados = leerAjustes(store);
  let aplicados = 0;
  for (const c of CAMPOS) {
    const v = guardados[c.clave];
    if (v === undefined) continue;
    process.env[c.env] = v;
    aplicados++;
  }
  if (aplicados) reloadConfig();
  return aplicados;
}

/**
 * Guarda un ajuste y lo aplica en caliente. Un valor vacio lo borra y devuelve
 * el control al .env (si es que ahi hay algo).
 *
 * Devuelve `aviso` cuando el valor se corrigio: paso de verdad que alguien
 * escribiera el endpoint con `.com` en lugar de `.io` y el sistema quedara sin
 * poder hablar con el modelo, con un "fetch failed" como unica pista.
 */
export function guardarAjuste(store, clave, valor) {
  const campo = campoPorClave(clave);
  if (!campo) throw new Error(`ajuste desconocido: ${clave}`);
  const crudo = String(valor ?? "").trim();

  if (!crudo) {
    store.del?.(`${PREFIJO}${clave}`);
    delete process.env[campo.env];
    reloadConfig();
    return { clave, borrado: true, aviso: null };
  }

  const { valor: limpio, aviso } = revisarValor(campo, crudo);
  store.set(`${PREFIJO}${clave}`, limpio);
  process.env[campo.env] = limpio;
  reloadConfig();
  return { clave, borrado: false, aviso };
}

// Hosts de MiniMax que existen de verdad. `api.minimax.com` NO es uno: no
// resuelve, y quien lo escribe se queda esperando 15 minutos por request.
const HOSTS_MINIMAX = ["api.minimax.io", "api.minimaxi.com"];

/**
 * Corrige lo que es evidentemente un error de tipeo y avisa; rechaza lo que no
 * se puede interpretar. No inventa: si el host no se parece a ninguno conocido,
 * lo deja pasar (puede ser un proxy propio) pero lo dice.
 */
export function revisarValor(campo, valor) {
  if (campo.clave !== "minimax_base_url") return { valor, aviso: null };

  let url;
  try {
    url = new URL(valor);
  } catch {
    throw new Error(`el endpoint no es una URL valida: ${valor}`);
  }

  const host = url.host.toLowerCase();
  if (HOSTS_MINIMAX.includes(host)) return { valor, aviso: null };

  // El typo clasico: .com por .io.
  if (host === "api.minimax.com") {
    const corregido = valor.replace("api.minimax.com", "api.minimax.io");
    return {
      valor: corregido,
      aviso: `api.minimax.com no existe (es api.minimax.io): se guardo ${corregido}`,
    };
  }
  return {
    valor,
    aviso:
      `${host} no es un host conocido de MiniMax (${HOSTS_MINIMAX.join(" o ")}). ` +
      "Si es un proxy tuyo, ignora este aviso; si no, borra el campo para usar el default.",
  };
}

/**
 * Lo que la pantalla de ajustes necesita saber de cada campo, sin exponer los
 * secretos: de donde viene el valor y una pista de cual es.
 */
export function estadoAjustes(store, entorno = entornoOriginal ?? {}) {
  const guardados = leerAjustes(store);
  return CAMPOS.map((c) => {
    const enPanel = guardados[c.clave];
    const enEnv = entorno[c.env];
    const activo = enPanel ?? enEnv ?? "";
    return {
      ...c,
      definido: !!activo,
      origen: enPanel ? "panel" : enEnv ? "env" : null,
      // Los dos lados definidos: la pantalla lo avisa, porque el .env deja de
      // tener efecto y eso desconcierta a quien lo edito.
      pisandoEnv: !!enPanel && !!enEnv && enPanel !== enEnv,
      pista: c.secreto ? pista(activo) : activo,
    };
  });
}

/** Ultimos caracteres, lo justo para reconocer cual es sin filtrarlo. */
export function pista(valor) {
  const v = String(valor ?? "");
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return `${"•".repeat(6)}${v.slice(-4)}`;
}

/** ¿Hay con que hablarle al modelo? Sin esto no se genera nada. */
export function modeloConfigurado(cfg) {
  return !!cfg?.secrets?.minimaxApiKey;
}

/** ¿Telegram esta listo? Es opcional: sin el, el contenido vive en el panel. */
export function telegramConfigurado(cfg) {
  return !!cfg?.secrets?.telegramToken && !!cfg?.secrets?.telegramChatId;
}
