// El chasis del panel: layout, estilos y el JS propio.
//
// Sin build y sin dependencias. Todo lo que el navegador necesita sale de este
// archivo como texto: se sube a un servidor con node y anda.
//
// La idea que ordena el diseno: el panel es el taller de la marca, asi que se
// pinta con la marca que estas mirando. Los colores salen de `brand.palette` y
// los titulos de la tipografia display real de la marca, que ya esta embebida
// en disco y se sirve desde /marca/<id>/fuentes.css. Cambias de marca y cambia
// la pantalla — que es, ademas, la mejor demo de lo que hace el producto.
//
// Eso es seguro porque `normalizePalette` (brand.mjs) garantiza los contrastes
// WCAG de la paleta antes de guardarla: ink sobre bg >= 4.5, accent sobre bg
// >= 3, onAccent sobre accent >= 4.5. Lo que derivamos aca se calcula sobre esa
// base y los colores de estado se fuerzan contra el fondo de cada marca.

import { contrast, esOscuro, forzarContraste, mezclar, toHex } from "./color.mjs";

export const PRODUCTO = "Brand Content AI";

/**
 * Temas. "auto" deja mandar a la marca activa (y al sistema cuando no hay
 * ninguna); "claro" y "oscuro" son la decision explicita de quien mira, y esa
 * gana siempre — incluso sobre la paleta de la marca.
 */
export const TEMAS = ["auto", "claro", "oscuro"];

// Neutro de fabrica: gris de papel tecnico y una tinta azul de plano. Es lo que
// se ve antes de que exista una marca, asi que dura poco a proposito.
const NEUTRO_CLARO = {
  bg: "#F7F8FA",
  surface: "#FFFFFF",
  ink: "#16191F",
  muted: "#5B6472",
  hint: "#828C9B",
  line: "#E1E5EB",
  accent: "#2B4FD8",
  onAccent: "#FFFFFF",
};

const NEUTRO_OSCURO = {
  bg: "#101317",
  surface: "#171B21",
  ink: "#E9ECF1",
  muted: "#98A2B1",
  hint: "#6F7988",
  line: "#252B33",
  accent: "#6E8CFF",
  onAccent: "#0B0D10",
};

const CLAVES_PALETA = ["bg", "surface", "ink", "muted", "hint", "line", "accent", "onAccent"];

// Estados. Se declaran como intencion y despues se fuerzan contra el fondo de
// la marca: un verde que no se lee sobre un bg lima no sirve de nada.
const ESTADO_BASE = { ok: "#1E9E5A", warn: "#C98A16", err: "#D6453F" };

export function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Los custom properties de una pantalla, a partir de la paleta que le toca.
 *
 * Todo lo que no viene dado se deriva mezclando contra el fondo o la tinta, de
 * forma que una marca clara y una oscura produzcan jerarquias equivalentes sin
 * que haya que escribir dos hojas de estilo.
 */
function tokens(paletaCruda, tema) {
  const forzado = tema === "claro" ? NEUTRO_CLARO : tema === "oscuro" ? NEUTRO_OSCURO : null;
  const base = forzado ?? paletaCruda ?? NEUTRO_CLARO;

  const p = {};
  for (const k of CLAVES_PALETA) p[k] = toHex(base[k]) ?? NEUTRO_CLARO[k];
  // `hint` no esta en las paletas viejas: se deriva a mitad de camino.
  if (!toHex(base.hint)) p.hint = mezclar(p.bg, p.ink, 0.45);

  const oscuro = esOscuro(p.bg);
  const haciaBorde = oscuro ? "#FFFFFF" : "#000000";

  const estados = Object.fromEntries(
    Object.entries(ESTADO_BASE).map(([k, c]) => [k, forzarContraste(c, p.bg, 4.5)]),
  );

  return {
    oscuro,
    css: [
      `--bg:${p.bg}`,
      `--surface:${p.surface}`,
      // Una tercera superficie para lo que flota sobre una tarjeta.
      `--surface-2:${mezclar(p.surface, haciaBorde, 0.05)}`,
      `--ink:${p.ink}`,
      `--muted:${p.muted}`,
      `--hint:${p.hint}`,
      `--line:${p.line}`,
      `--line-fuerte:${mezclar(p.line, haciaBorde, 0.22)}`,
      `--accent:${p.accent}`,
      `--on-accent:${p.onAccent}`,
      // El acento diluido: fondos de chip y estados de hover que no gritan.
      `--accent-suave:${mezclar(p.bg, p.accent, 0.14)}`,
      `--accent-borde:${mezclar(p.bg, p.accent, 0.36)}`,
      `--hover:${mezclar(p.surface, haciaBorde, 0.06)}`,
      `--ok:${estados.ok}`,
      `--warn:${estados.warn}`,
      `--err:${estados.err}`,
      `--ok-suave:${mezclar(p.bg, estados.ok, 0.16)}`,
      `--warn-suave:${mezclar(p.bg, estados.warn, 0.16)}`,
      `--err-suave:${mezclar(p.bg, estados.err, 0.16)}`,
      `--sombra:${oscuro ? "0 1px 2px rgba(0,0,0,.5)" : "0 1px 2px rgba(16,19,23,.06)"}`,
      `--sombra-alta:${oscuro ? "0 8px 28px rgba(0,0,0,.55)" : "0 8px 28px rgba(16,19,23,.10)"}`,
    ].join(";"),
  };
}

/** La pila tipografica: la display de la marca al frente, con red de contencion. */
function pilaTipografica(brand) {
  const display = brand?.fonts?.display?.family;
  const mono = brand?.fonts?.mono?.family;
  const uiStack = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif`;
  const monoStack = `ui-monospace, "Cascadia Mono", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", monospace`;
  return [
    `--fuente-ui:${uiStack}`,
    `--fuente-display:${display ? `"${display}", ` : ""}${uiStack}`,
    `--fuente-mono:${mono ? `"${mono}", ` : ""}${monoStack}`,
  ].join(";");
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

const ESTADO_TONO = {
  planned: "espera",
  briefed: "espera",
  building: "curso",
  built: "ok",
  delivered: "ok",
  approved: "ok",
  rejected: "mal",
  // No es un status de la base: es `building` con el proceso muerto. Se pinta
  // distinto a proposito, porque quien lo ve tiene que dejar de esperar.
  detenido: "detenido",
};

/** El estado de una pieza, como etiqueta con color propio. */
export function chipEstado(status, etiqueta) {
  const tono = ESTADO_TONO[status] ?? "espera";
  return `<span class="chip ${esc(tono)}">${esc(etiqueta ?? status)}</span>`;
}

/**
 * La marca vista como se ve: su fondo, su tipografia, su acento. No es un
 * adorno — es la unica forma de saber de un vistazo si la identidad que armo
 * el modelo es la que querias, sin abrir una pieza renderizada.
 */
export function muestraMarca(brand, { alto = 150 } = {}) {
  const p = brand?.palette ?? {};
  const bg = toHex(p.bg) ?? NEUTRO_OSCURO.bg;
  const ink = toHex(p.ink) ?? NEUTRO_OSCURO.ink;
  const accent = toHex(p.accent) ?? NEUTRO_OSCURO.accent;
  const muted = toHex(p.muted) ?? mezclar(bg, ink, 0.6);
  const display = brand?.fonts?.display?.family;
  const familia = display ? `"${esc(display)}", var(--fuente-display)` : "var(--fuente-display)";
  const linea = brand?.tagline ?? brand?.audience ?? brand?.site ?? "";

  return `<div class="marca-lienzo" style="height:${Number(alto)}px;background:${bg};color:${ink}">
    <div class="marca-nombre" style="font-family:${familia}">${esc(brand?.name ?? "—")}</div>
    ${linea ? `<div class="marca-linea" style="color:${muted}">${esc(recorte(linea, 68))}</div>` : ""}
    <div class="marca-regla" style="background:${accent}"></div>
  </div>`;
}

/** La paleta como muestras con su hex: para copiar y para auditar de un vistazo. */
export function swatches(palette = {}) {
  const claves = CLAVES_PALETA.filter((k) => toHex(palette[k]));
  if (!claves.length) return `<p class="mini faint">Esta marca todavia no tiene paleta.</p>`;
  return `<div class="swatches">${claves
    .map((k) => {
      const hex = toHex(palette[k]);
      const borde = contrast(hex, "#FFFFFF") < 1.35 ? "var(--line-fuerte)" : "transparent";
      return `<div class="swatch" title="${esc(k)} ${esc(hex)}">
        <span class="swatch-color" style="background:${hex};border-color:${borde}"></span>
        <span class="swatch-clave">${esc(k)}</span>
        <span class="swatch-hex mono">${esc(hex)}</span>
      </div>`;
    })
    .join("")}</div>`;
}

/**
 * El `<link>` a las tipografias de una marca. Son las que ya se bajaron y
 * quedaron embebidas en su proyecto, servidas desde este mismo panel: el panel
 * no le pide fuentes a Google en tiempo de uso.
 */
export function fuentesDeMarca(brand) {
  if (!brand?.id || !brand?.projectDir) return "";
  return `<link rel="stylesheet" href="/marca/${encodeURIComponent(brand.id)}/fuentes.css">`;
}

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

const TABS = [
  { id: "crear", href: "/crear", texto: "Crear" },
  { id: "calendario", href: "/calendario", texto: "Calendario" },
  { id: "marcas", href: "/marcas", texto: "Marcas" },
  { id: "costos", href: "/costos", texto: "Costos" },
  { id: "equipo", href: "/equipo", texto: "Equipo" },
  { id: "ajustes", href: "/ajustes", texto: "Ajustes" },
];

export function pagina({
  titulo,
  cuerpo,
  tema = "auto",
  tab = "",
  cabeza = "",
  autenticado = true,
  marcas = [],
  marcaActiva = "",
  msg = "",
  err = "",
  usuario = null,
  faltaEmpezar = false,
} = {}) {
  const activa = marcas.find((m) => m.id === marcaActiva) ?? null;
  const t = tokens(activa?.palette, tema);
  const titulos = `${titulo ? `${titulo} · ` : ""}${PRODUCTO}`;

  return `<!doctype html>
<html lang="es" data-tema="${esc(tema)}" data-luz="${t.oscuro ? "oscuro" : "claro"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${t.oscuro ? "dark" : "light"}">
<title>${esc(titulos)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon(activa))}">
${autenticado ? fuentesDeMarca(activa) : ""}
${cabeza}
<style>:root{${t.css};${pilaTipografica(activa)}}
${CSS}</style>
</head>
<body>
${autenticado ? barra({ activa, marcas, marcaActiva, tab, usuario, faltaEmpezar }) : bandaSuelta(activa)}
<main class="lienzo${autenticado ? "" : " suelto"}">
${msg ? `<div class="aviso bien" role="status">${esc(msg)}</div>` : ""}
${err ? `<div class="aviso mal" role="alert">${esc(err)}</div>` : ""}
${cuerpo}
</main>
<script>${JS}</script>
</body>
</html>`;
}

/**
 * La banda de paleta: el elemento con el que se reconoce esta pantalla.
 *
 * Son los colores de la marca activa en el borde de arriba, en el orden en que
 * los usa una composicion. Ocupa 4px y dice de que marca es todo lo que estas
 * viendo, sin ningun texto.
 */
function banda(brand) {
  const p = brand?.palette ?? {};
  const orden = ["accent", "ink", "muted", "line", "surface", "bg"];
  const colores = orden.map((k) => toHex(p[k])).filter(Boolean);
  if (colores.length < 3) return `<div class="banda banda-vacia"></div>`;
  const paso = 100 / colores.length;
  const tramos = colores
    .map((c, i) => `${c} ${(i * paso).toFixed(2)}%, ${c} ${((i + 1) * paso).toFixed(2)}%`)
    .join(", ");
  return `<div class="banda" style="background:linear-gradient(90deg, ${tramos})"></div>`;
}

/**
 * La banda en las pantallas sin sesión.
 *
 * Si hay marca activa se muestra igual, porque ya dice de quién es esta
 * instalación. Sin marca no hay nada que mostrar: una franja gris arriba de un
 * login es ruido, no identidad.
 */
function bandaSuelta(brand) {
  return brand?.palette ? banda(brand) : "";
}

function barra({ activa, marcas, marcaActiva, tab, usuario, faltaEmpezar }) {
  const tabs = faltaEmpezar
    ? [{ id: "empezar", href: "/empezar", texto: "Empezar" }, ...TABS]
    : TABS;

  return `${banda(activa)}
<header class="cabecera">
  <div class="cabecera-fila">
    <a class="marca-actual" href="/marcas" title="${esc(activa ? `Abrir ${activa.name}` : "Crear tu primera marca")}">
      ${activa ? `<span class="marca-punto" style="background:${esc(toHex(activa.palette?.accent) ?? "var(--accent)")}"></span>` : ""}
      <span class="marca-titulo">${esc(activa?.name ?? PRODUCTO)}</span>
    </a>

    ${
      marcas.length > 1
        ? `<form class="cambiar-marca" method="post" action="/action/marca-usar">
             <input type="hidden" name="back" value="${esc(rutaDe(tab))}">
             <label class="oculto" for="barra-marca">Marca sobre la que trabajar</label>
             <select id="barra-marca" name="brand" data-envia data-libre="1" title="Cambia la marca sobre la que trabajas">
               ${marcas
                 .map(
                   (m) =>
                     `<option value="${esc(m.id)}"${m.id === marcaActiva ? " selected" : ""}>${esc(m.name)}</option>`,
                 )
                 .join("")}
             </select>
             <noscript><button class="chico" type="submit">Cambiar</button></noscript>
           </form>`
        : ""
    }

    <nav class="tabs" aria-label="Secciones">
      ${tabs
        .map(
          (x) =>
            `<a class="tab${x.id === tab ? " activo" : ""}" href="${x.href}"${x.id === tab ? ' aria-current="page"' : ""}>${esc(x.texto)}</a>`,
        )
        .join("")}
    </nav>

    <div class="cabecera-fin">
      <button type="button" class="tema" data-tema-toggle data-libre="1" title="Cambiar entre el tema de la marca, claro y oscuro">
        <span data-tema-nombre></span>
      </button>
      ${
        usuario
          ? `<div class="yo">
               <a class="usuario" href="/equipo" title="${esc(usuario.name || usuario.email)} — ver el equipo">${esc(iniciales(usuario.name || usuario.email))}</a>
               <div class="yo-menu">
                 <div class="yo-quien">
                   <strong>${esc(usuario.name || usuario.email)}</strong>
                   <div class="mini faint">${esc(usuario.email ?? "")}${usuario.role === "owner" ? " · dueño" : ""}</div>
                 </div>
                 <a class="yo-item" href="/equipo">Equipo e invitaciones</a>
                 <a class="yo-item" href="/ajustes">Ajustes</a>
                 <a class="yo-item salir" href="/salir">Cerrar sesión</a>
               </div>
             </div>`
          : `<a class="boton chico" href="/salir" title="Volver a la pantalla de entrada">Salir</a>`
      }
    </div>
  </div>
</header>`;
}

/** A donde vuelve el selector de marca: la pantalla en la que estabas. */
function rutaDe(tab) {
  const encontrado = TABS.find((x) => x.id === tab);
  if (encontrado) return encontrado.href;
  return tab === "empezar" ? "/empezar" : "/crear";
}

function iniciales(nombre) {
  const partes = String(nombre ?? "").trim().split(/[\s@._-]+/).filter(Boolean);
  if (!partes.length) return "?";
  return (partes[0][0] + (partes[1]?.[0] ?? "")).toUpperCase();
}

function favicon(brand) {
  const bg = toHex(brand?.palette?.bg) ?? NEUTRO_OSCURO.bg;
  const accent = toHex(brand?.palette?.accent) ?? NEUTRO_CLARO.accent;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/><rect x="7" y="7" width="18" height="18" rx="3" fill="${accent}"/></svg>`;
}

function recorte(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:var(--fuente-ui);font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
::selection{background:var(--accent);color:var(--on-accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.oculto{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* --- banda de paleta: la firma de la pantalla ------------------------- */
.banda{height:4px;width:100%;position:sticky;top:0;z-index:30}
.banda-vacia{background:var(--line)}

/* --- barra superior --------------------------------------------------- */
/* Se llama .cabecera y no .barra porque .barra ya era la barra de progreso de
   las vistas: dos reglas con el mismo nombre y la de abajo, con height:3px y
   overflow:hidden, aplastaba el header entero. */
.cabecera{
  position:sticky;top:4px;z-index:20;
  background:color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter:saturate(180%) blur(12px);
  border-bottom:1px solid var(--line);
}
@supports not (backdrop-filter:blur(1px)){.cabecera{background:var(--bg)}}
.cabecera-fila{
  max-width:1240px;margin:0 auto;padding:10px 24px;
  display:flex;align-items:center;gap:18px;flex-wrap:wrap;
}
.marca-actual{
  display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--ink);
  font-family:var(--fuente-display);font-size:17px;font-weight:600;
  letter-spacing:-.015em;padding:2px 0;
}
.marca-actual:hover{color:var(--accent)}
.marca-punto{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 0 3px var(--accent-suave)}
.marca-titulo{max-width:26ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cambiar-marca{margin:0}
.cambiar-marca select{width:auto;min-width:120px;padding:5px 9px;font-size:12.5px}

.tabs{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap}
.tab{
  padding:6px 11px;border-radius:7px;text-decoration:none;
  color:var(--muted);font-size:13px;font-weight:500;white-space:nowrap;
}
.tab:hover{background:var(--hover);color:var(--ink)}
.tab.activo{background:var(--accent-suave);color:var(--ink);font-weight:600}

.cabecera-fin{display:flex;align-items:center;gap:8px}
.tema{
  background:none;border:1px solid var(--line);color:var(--muted);
  padding:4px 9px;border-radius:7px;font-size:11.5px;cursor:pointer;
  font-family:inherit;letter-spacing:.04em;text-transform:uppercase;
}
.tema:hover{border-color:var(--line-fuerte);color:var(--ink)}
.usuario{
  width:29px;height:29px;border-radius:50%;display:grid;place-items:center;
  background:var(--accent);color:var(--on-accent);text-decoration:none;
  font-size:11.5px;font-weight:700;letter-spacing:.02em;
}
/* El avatar abre el menu de cuenta. Con :hover y :focus-within funciona sin una
   linea de JS y sigue siendo alcanzable con el teclado. */
.yo{position:relative}
.yo-menu{
  position:absolute;right:0;top:calc(100% + 8px);min-width:210px;z-index:40;
  background:var(--surface);border:1px solid var(--line);border-radius:10px;
  box-shadow:var(--sombra-alta);padding:6px;
  opacity:0;visibility:hidden;transform:translateY(-4px);
  transition:opacity .12s ease,transform .12s ease,visibility .12s;
}
.yo:hover .yo-menu,.yo:focus-within .yo-menu{opacity:1;visibility:visible;transform:none}
.yo-quien{padding:8px 10px 10px;border-bottom:1px solid var(--line);margin-bottom:6px;font-size:13px}
.yo-item{
  display:block;padding:7px 10px;border-radius:7px;font-size:13px;
  color:var(--ink);text-decoration:none;
}
.yo-item:hover{background:var(--hover)}
.yo-item.salir{color:var(--err);margin-top:2px;border-top:1px solid var(--line);border-radius:0 0 7px 7px}
.yo-item.salir:hover{background:var(--err-suave)}

/* --- portada: login, alta de cuenta, invitacion ------------------------ */
/* Una columna angosta apoyada en la pagina, sin tarjeta. Es la unica pantalla
   sin marca que mostrar, asi que la jerarquia la cargan el tamanio y el aire. */
.portada{max-width:352px;margin:0 auto;padding:16vh 24px 96px}
.portada-marca{display:flex;align-items:center;gap:11px;margin-bottom:10px}
.portada-punto{
  width:11px;height:11px;border-radius:50%;background:var(--accent);flex:none;
  box-shadow:0 0 0 4px var(--accent-suave);
}
.portada-titulo{font-size:23px;margin:0;letter-spacing:-.02em}
.portada-linea{color:var(--muted);font-size:14px;margin:0 0 30px}
.portada-form{margin-bottom:22px}
.portada-form .campo{margin-bottom:16px}
.portada-form input{padding:10px 12px;font-size:14px}
.portada-pie{font-size:12px;line-height:1.5;color:var(--hint);margin:0;padding-top:18px;border-top:1px solid var(--line)}
.portada-pie a{color:var(--muted)}
@media (max-width:520px){.portada{padding-top:10vh}}

/* --- lienzo y tipografia ---------------------------------------------- */
.lienzo{max-width:1240px;margin:0 auto;padding:30px 24px 96px}
.lienzo.suelto{padding-top:0}
h1{
  font-family:var(--fuente-display);font-size:29px;line-height:1.15;
  font-weight:600;letter-spacing:-.022em;margin:0 0 6px;
}
h2{
  font-size:11.5px;font-weight:650;letter-spacing:.10em;text-transform:uppercase;
  color:var(--hint);margin:38px 0 12px;
}
h3{font-size:14px;font-weight:650;letter-spacing:-.005em;margin:0 0 8px}
p{margin:0 0 10px}
/* El acento se gasta en lo que es una accion. Un titulo de pieza dentro de una
   tabla es contenido, no un boton: pintarlo del color de marca convertia cada
   listado en una pared de rojo (o de lima, segun la marca) y hacia que el unico
   boton que importa dejara de destacar. */
a{color:var(--accent);text-underline-offset:2px}
td a,.pieza,.marca-actual{color:var(--ink);text-decoration:none}
td a{text-decoration:underline;text-decoration-color:var(--line-fuerte)}
td a:hover{color:var(--accent);text-decoration-color:currentColor}
strong{font-weight:650}
code{font-family:var(--fuente-mono);font-size:.9em;background:var(--hover);padding:1px 5px;border-radius:4px}
.sub{color:var(--muted);margin:0 0 22px;max-width:74ch}
.mini{font-size:12.5px;line-height:1.5}
.dim{color:var(--muted)}
.faint{color:var(--hint)}
.mono{font-family:var(--fuente-mono);font-variant-numeric:tabular-nums}
.err{color:var(--err)}
.warn{color:var(--warn)}

/* --- estructura ------------------------------------------------------- */
.fila{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.entre{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.grid{display:grid;gap:18px}
.grid.dos{grid-template-columns:1fr 1fr;align-items:start}
@media (max-width:860px){.grid.dos{grid-template-columns:1fr}}

.card{
  background:var(--surface);border:1px solid var(--line);border-radius:11px;
  padding:18px;margin-bottom:14px;box-shadow:var(--sombra);
}
.card > :last-child{margin-bottom:0}
details.card > summary{cursor:pointer;list-style:none;user-select:none}
details.card > summary::-webkit-details-marker{display:none}
details.card > summary::before{content:"▸ ";color:var(--hint)}
details.card[open] > summary::before{content:"▾ "}

/* --- formularios ------------------------------------------------------ */
.campo{margin-bottom:14px}
.campo:last-child{margin-bottom:0}
label{display:block;font-size:12.5px;font-weight:600;margin-bottom:5px;color:var(--ink)}
input,select,textarea{
  width:100%;padding:8px 11px;font:inherit;font-size:13.5px;color:var(--ink);
  background:var(--bg);border:1px solid var(--line-fuerte);border-radius:8px;
}
input:hover,select:hover,textarea:hover{border-color:var(--accent-borde)}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-suave);
}
input[type=checkbox]{width:auto;accent-color:var(--accent)}
input[readonly]{background:var(--hover);color:var(--muted)}
input:disabled,select:disabled,textarea:disabled{opacity:.55;cursor:not-allowed}
textarea{min-height:88px;resize:vertical;line-height:1.5}
select{
  appearance:none;padding-right:30px;cursor:pointer;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 15px) 53%,calc(100% - 10px) 53%;
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;
}
.ayuda{font-size:12px;color:var(--hint);margin-top:5px;line-height:1.45}

/* --- botones ---------------------------------------------------------- */
button,.boton{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:8px 15px;font:inherit;font-size:13px;font-weight:600;line-height:1.2;
  color:var(--ink);background:var(--surface-2);
  border:1px solid var(--line-fuerte);border-radius:8px;
  cursor:pointer;text-decoration:none;white-space:nowrap;
  transition:background .12s ease,border-color .12s ease,transform .12s ease;
}
button:hover,.boton:hover{background:var(--hover);border-color:var(--accent-borde)}
button:active,.boton:active{transform:translateY(1px)}
button:disabled,.boton:disabled{opacity:.5;cursor:not-allowed;transform:none}
button.primario,.boton.primario{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button.primario:hover,.boton.primario:hover{background:var(--accent);border-color:var(--accent);filter:brightness(1.08)}
button.peligro,.boton.peligro{color:var(--err);border-color:var(--err-suave)}
button.peligro:hover,.boton.peligro:hover{background:var(--err-suave);border-color:var(--err)}
button.chico,.boton.chico{padding:5px 10px;font-size:12px;border-radius:7px}
form{margin:0}

/* --- avisos y chips --------------------------------------------------- */
.aviso{
  border:1px solid var(--line-fuerte);border-left-width:3px;border-radius:9px;
  padding:11px 14px;margin-bottom:16px;font-size:13px;
}
.aviso.bien{background:var(--ok-suave);border-color:var(--ok)}
.aviso.mal{background:var(--err-suave);border-color:var(--err)}
.chip{
  display:inline-flex;align-items:center;gap:5px;
  padding:2px 8px;border-radius:99px;font-size:11px;font-weight:650;
  letter-spacing:.02em;background:var(--hover);color:var(--muted);
  border:1px solid var(--line);white-space:nowrap;
}
.chip.ok,.chip.built{background:var(--ok-suave);color:var(--ok);border-color:transparent}
.chip.curso{background:var(--accent-suave);color:var(--ink);border-color:var(--accent-borde)}
.chip.mal{background:var(--err-suave);color:var(--err);border-color:transparent}
.chip.espera{background:var(--hover);color:var(--muted)}
/* Detenido no es un error ni un estado en curso: es trabajo que quedo a medias
   y espera una decision. Lleva borde punteado para leerse como "incompleto" de
   un vistazo, incluso en el calendario donde el chip es lo unico que se ve. */
.chip.detenido{background:var(--warn-suave);color:var(--warn);border:1px dashed var(--warn)}

/* --- trabajo en curso -------------------------------------------------- */
.vivo{
  display:inline-block;width:7px;height:7px;border-radius:50%;
  background:var(--accent);margin-right:7px;vertical-align:middle;
  animation:latir 1.5s ease-in-out infinite;
}
@keyframes latir{0%,100%{opacity:1;box-shadow:0 0 0 0 var(--accent-suave)}50%{opacity:.65;box-shadow:0 0 0 5px transparent}}
.barra{height:3px;background:var(--line);border-radius:99px;overflow:hidden}
.barra > i{display:block;height:100%;width:38%;background:var(--accent);border-radius:99px;animation:correr 1.5s ease-in-out infinite}
@keyframes correr{0%{transform:translateX(-100%)}100%{transform:translateX(365%)}}

/* --- tablas ------------------------------------------------------------ */
table{width:100%;border-collapse:collapse;font-size:13px}
th{
  text-align:left;font-size:11px;font-weight:650;letter-spacing:.07em;
  text-transform:uppercase;color:var(--hint);
  padding:0 10px 7px;border-bottom:1px solid var(--line);
}
td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
/* Las celdas angostas llevan un dato atomico —una fecha, un formato, un id— que
   partido en dos lineas deja de leerse como un dato. */
td.mono,td:has(> .mono){white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--hover)}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}

/* --- bloques de texto crudo -------------------------------------------- */
.bloque{
  font-family:var(--fuente-mono);font-size:12px;line-height:1.55;
  background:var(--bg);border:1px solid var(--line);border-radius:8px;
  padding:13px;margin:0;max-height:440px;overflow:auto;white-space:pre-wrap;
  word-break:break-word;color:var(--muted);
}

/* --- bitacora de una pieza -------------------------------------------- */
/* Lo bloqueante se distingue a simple vista de lo cosmetico, igual que en el
   prompt que le llega al modelo. */
.bitacora{max-height:360px}
.bitacora .linea{padding:1px 0}
.bitacora .hora{color:var(--hint);margin-right:10px;user-select:none}
.bitacora .nivel-error{color:var(--err);font-weight:600}
.bitacora .nivel-aviso{color:var(--warn)}
.bitacora .nivel-info{color:var(--muted)}
.nivel-error{color:var(--err)}
.nivel-aviso{color:var(--warn)}
.nivel-info{color:var(--muted)}

/* --- calendario --------------------------------------------------------- */
.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.dow{
  font-size:10.5px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;
  color:var(--hint);padding:0 4px 2px;
}
.dia{
  background:var(--surface);border:1px solid var(--line);border-radius:9px;
  padding:8px;min-height:104px;
}
.dia.hoy{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-suave)}
.fecha{font-size:11px;font-weight:650;color:var(--hint);margin-bottom:6px;letter-spacing:.01em}
.dia.hoy .fecha{color:var(--accent)}
.pieza{
  display:block;text-decoration:none;color:var(--ink);
  background:var(--bg);border:1px solid var(--line);border-radius:7px;
  padding:6px 7px;margin-bottom:5px;font-size:11.5px;line-height:1.35;
}
.pieza:hover{border-color:var(--accent-borde);background:var(--hover)}
.pieza:last-child{margin-bottom:0}
.fmt{
  font-family:var(--fuente-mono);font-size:10px;color:var(--hint);
  letter-spacing:.03em;text-transform:uppercase;
}
@media (max-width:900px){
  .cal{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cal .dow{display:none}
  .dia{min-height:0}
}

/* --- marcas -------------------------------------------------------------- */
.tarjeta-marca{
  border:1px solid var(--line);border-radius:11px;overflow:hidden;
  background:var(--surface);box-shadow:var(--sombra);
}
.tarjeta-marca .pie{padding:12px 14px;border-top:1px solid var(--line)}
.marca-lienzo{
  position:relative;display:flex;flex-direction:column;justify-content:center;
  gap:5px;padding:20px 22px;overflow:hidden;
}
.marca-nombre{font-size:25px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.marca-linea{font-size:12.5px;line-height:1.4;max-width:46ch}
.marca-regla{position:absolute;left:0;bottom:0;height:4px;width:38%}
.swatches{display:flex;flex-wrap:wrap;gap:6px}
.swatch{display:flex;align-items:center;gap:6px;font-size:11px}
.swatch-color{
  width:17px;height:17px;border-radius:5px;display:block;flex:none;
  border:1px solid transparent;
}
.swatch-clave{color:var(--muted)}
.swatch-hex{color:var(--hint);font-size:10.5px}

/* --- previsualizacion de piezas ------------------------------------------ */
.preview{
  background:var(--bg);border:1px solid var(--line);border-radius:9px;
  overflow:hidden;display:grid;place-items:center;
}
.preview img,.preview video{display:block;max-width:100%;height:auto}
.slides{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}

@media (max-width:640px){
  .lienzo{padding:22px 16px 72px}
  .cabecera-fila{padding:9px 16px;gap:12px}
  .tabs{margin-left:0;order:3;width:100%;overflow-x:auto}
  h1{font-size:24px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
  .barra > i{width:100%}
}
`;

// ---------------------------------------------------------------------------
// JS del panel
// ---------------------------------------------------------------------------

// Los hooks (data-esperando, data-vivo, data-ver, data-igual-que) ya viven en
// el HTML que arman las vistas. Esto es lo que los hace funcionar.
const JS = `
(function(){
  "use strict";

  // --- tema: marca -> claro -> oscuro ------------------------------------
  var TEMAS = ${JSON.stringify(TEMAS)};
  var NOMBRE = {auto:"marca", claro:"claro", oscuro:"oscuro"};
  function temaActual(){
    var t = document.documentElement.getAttribute("data-tema");
    return TEMAS.indexOf(t) >= 0 ? t : "auto";
  }
  function pintarTema(){
    var n = document.querySelector("[data-tema-nombre]");
    if (n) n.textContent = NOMBRE[temaActual()] || "marca";
  }
  pintarTema();
  var toggle = document.querySelector("[data-tema-toggle]");
  if (toggle) toggle.addEventListener("click", function(){
    var siguiente = TEMAS[(TEMAS.indexOf(temaActual()) + 1) % TEMAS.length];
    document.cookie = "bca_tema=" + siguiente + ";path=/;max-age=" + (60*60*24*365) + ";samesite=lax";
    location.reload();
  });

  // --- el selector de marca se envia solo --------------------------------
  document.querySelectorAll("select[data-envia]").forEach(function(sel){
    sel.addEventListener("change", function(){ if (sel.form) sel.form.submit(); });
  });

  // --- boton que espera ---------------------------------------------------
  // Deshabilitar en el mismo tick le saca el name/value al submit (Ajustes
  // manda 'probar=telegram' asi), por eso el trabajo va en un setTimeout: el
  // navegador ya serializo el formulario cuando corre.
  document.addEventListener("submit", function(ev){
    var form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    var btn = (ev.submitter && ev.submitter.tagName === "BUTTON") ? ev.submitter : form.querySelector("button[data-esperando]");
    if (!btn || btn.hasAttribute("data-libre")) return;
    var texto = btn.getAttribute("data-esperando");
    if (!texto) return;
    setTimeout(function(){
      btn.disabled = true;
      btn.textContent = texto;
    }, 0);
  });

  // --- ver la contrasena --------------------------------------------------
  document.querySelectorAll("[data-ver]").forEach(function(btn){
    btn.addEventListener("click", function(){
      var ids = btn.getAttribute("data-ver").split(",");
      var mostrando = btn.textContent.trim() === "ocultar";
      ids.forEach(function(id){
        var el = document.getElementById(id.trim());
        if (el) el.type = mostrando ? "password" : "text";
      });
      btn.textContent = mostrando ? "ver" : "ocultar";
    });
  });

  // --- las dos contrasenas tienen que coincidir ---------------------------
  document.querySelectorAll("[data-igual-que]").forEach(function(campo){
    var otro = document.getElementById(campo.getAttribute("data-igual-que"));
    var aviso = document.querySelector('[data-aviso-de="' + campo.id + '"]');
    if (!otro) return;
    function revisar(){
      var mal = campo.value && otro.value && campo.value !== otro.value;
      campo.setCustomValidity(mal ? (campo.getAttribute("data-error") || "no coinciden") : "");
      if (aviso){
        aviso.textContent = mal ? (campo.getAttribute("data-error") || "") : "";
        aviso.className = mal ? "ayuda err" : "ayuda";
      }
    }
    campo.addEventListener("input", revisar);
    otro.addEventListener("input", revisar);
  });

  // --- trabajo en curso: la pagina se actualiza sola -----------------------
  // La bitacora vive fuera de la caja: es la misma pieza, otra tarjeta. Se le
  // pide al server solo lo posterior a la ultima linea que ya se ve.
  var bitacora = document.querySelector("[data-log]");
  function horaDe(iso){
    if (!iso) return "";
    var d = new Date(iso.indexOf("T") >= 0 ? iso : iso.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
  }
  function agregarLineas(lineas){
    if (!bitacora || !lineas || !lineas.length) return;
    var abajo = bitacora.scrollTop + bitacora.clientHeight >= bitacora.scrollHeight - 8;
    lineas.forEach(function(l){
      var div = document.createElement("div");
      div.className = "linea nivel-" + (l.nivel === "error" || l.nivel === "aviso" ? l.nivel : "info");
      var hora = document.createElement("span");
      hora.className = "hora";
      hora.textContent = horaDe(l.created_at);
      div.appendChild(hora);
      div.appendChild(document.createTextNode(l.texto));
      bitacora.appendChild(div);
      bitacora.setAttribute("data-log-desde", String(l.id));
    });
    if (abajo) bitacora.scrollTop = bitacora.scrollHeight;
  }
  if (bitacora) bitacora.scrollTop = bitacora.scrollHeight;

  document.querySelectorAll("[data-vivo]").forEach(function(caja){
    var url = caja.getAttribute("data-vivo");
    var fallos = 0;
    var timer = setInterval(function(){
      var desde = bitacora ? (bitacora.getAttribute("data-log-desde") || "0") : "0";
      fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "desde=" + encodeURIComponent(desde), {headers:{accept:"application/json"}})
        .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
        .then(function(j){
          fallos = 0;
          agregarLineas(j.log);
          if (j.recargar){ clearInterval(timer); location.reload(); return; }
          caja.querySelectorAll("[data-campo]").forEach(function(el){
            var v = j[el.getAttribute("data-campo")];
            if (v != null && el.textContent !== String(v)) el.textContent = String(v);
          });
        })
        .catch(function(){
          // Un panel que se cae no tiene que dejar el navegador golpeandolo.
          if (++fallos >= 5) clearInterval(timer);
        });
    }, 2500);
  });
})();
`;
