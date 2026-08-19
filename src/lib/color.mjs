// Matematica de color: hex, contraste WCAG y mezcla.
//
// Vivia adentro de brand.mjs, que es quien la necesitaba primero para que las
// paletas que propone el modelo sean legibles. Ahora la usa tambien el panel
// (ui.mjs) para pintarse con la paleta de la marca activa, y hacer que la capa
// de presentacion importe brand.mjs — con su cliente HTTP, su lector de sitios
// y su descargador de fuentes — para calcular un contraste seria absurdo.
//
// Sin dependencias y sin efectos: funciones puras sobre strings hex.

/** Normaliza a #RRGGBB en mayusculas. Acepta 3 o 6 digitos, con o sin `#`. */
export function toHex(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^#?([0-9a-f]{6})$/i) ?? s.match(/^#?([0-9a-f]{3})$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  const full = h.length === 3 ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : h;
  return `#${full.toUpperCase()}`;
}

function rgb(hex) {
  const h = toHex(hex) ?? "#000000";
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function luminancia(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste WCAG entre dos colores: 1 (igual) a 21 (blanco sobre negro). */
export function contrast(a, b) {
  const la = luminancia(a);
  const lb = luminancia(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mezcla lineal entre dos colores; t=0 devuelve `a`, t=1 devuelve `b`. */
export function mezclar(a, b, t) {
  const A = rgb(a);
  const B = rgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * Acerca `color` al blanco o al negro hasta cumplir el contraste pedido contra
 * `fondo`. Conserva el tono todo lo que puede: mueve luminosidad, no matiz.
 */
export function forzarContraste(color, fondo, objetivo) {
  const haciaBlanco = luminancia(fondo) < 0.5;
  const destino = haciaBlanco ? "#FFFFFF" : "#000000";
  let mejor = toHex(color) ?? destino;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mezclar(color, destino, t);
    mejor = c;
    if (contrast(c, fondo) >= objetivo) return c;
  }
  return mejor;
}

/** `true` si el fondo es oscuro: decide si los derivados van hacia el blanco. */
export function esOscuro(hex) {
  return luminancia(hex) < 0.5;
}
