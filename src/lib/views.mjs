// Las vistas del panel. Funciones puras: reciben datos, devuelven HTML.
//
// Estan separadas del server para poder mirarlas (y cambiarlas) sin leer el
// ruteo, y para que el HTML no se mezcle con la logica de permisos y jobs.

import { esc, chipEstado, muestraMarca, swatches, PRODUCTO } from "./ui.mjs";

const DOW = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export const ETIQUETA_ESTADO = {
  planned: "planificado",
  briefed: "con brief",
  building: "generando",
  built: "listo",
  delivered: "entregado",
  approved: "aprobado",
  rejected: "rechazado",
};

/**
 * El chip de una pieza, sabiendo si su trabajo sigue vivo.
 *
 * `building` en la base significa "alguien la empezó", no "alguien la está
 * haciendo": si el proceso murió, la fila queda igual. Por eso el estado que se
 * muestra no sale solo del status — necesita saber si hay alguien trabajando.
 *
 * `detenida` puede ser un booleano o el objeto de `estadoDe()`.
 */
export function chipDePieza(item, detenida) {
  const muerta =
    typeof detenida === "object" && detenida !== null
      ? detenida.kind === "stale" || detenida.kind === "orphan"
      : !!detenida;
  if (item.status === "building" && muerta) {
    return chipEstado("detenido", "detenido");
  }
  return chipEstado(item.status, ETIQUETA_ESTADO[item.status] ?? item.status);
}

const ETIQUETA_FASE = {
  brief: "escribiendo el brief",
  compose: "componiendo escenas",
  check: "revisando el layout",
  repair: "reparando lo que marcó el check",
  render: "renderizando",
  plan: "planificando",
  marca: "armando la marca",
};

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

/**
 * El tab que hace la promesa del producto: le pedis una pieza y la hace ahora.
 * No toca el calendario — lo que se pide acá sale con fecha de hoy y arranca.
 */
export function vistaCrear({ cfg, brand, recientes = [], enCurso = [], hayTelegram = false, detenidos = new Set() }) {
  if (!brand) {
    return `<h1>Todavía no hay ninguna marca</h1>
    <p class="sub">${PRODUCTO} genera contenido para una marca: sus colores, su voz y sus hechos. Creá la primera y después volve acá.</p>
    <a class="boton primario" href="/marcas">Crear mi primera marca</a>`;
  }

  const ORDEN = ["text", "image", "story", "carousel", "video", "reel"];
  const formatos = Object.entries(cfg.formats ?? {})
    .filter(([, f]) => f?.enabled !== false)
    .map(([k, f]) => ({ k, spec: describirFormato(k, f) }))
    .sort((a, b) => (ORDEN.indexOf(a.k) + 99) % 99 - ((ORDEN.indexOf(b.k) + 99) % 99));
  const idiomas = brand.languages?.length ? brand.languages : ["en"];

  return `<h1>Crear una pieza</h1>
<p class="sub">Decí qué querés comunicar. ${PRODUCTO} escribe el brief, compone y renderiza con la identidad de <strong>${esc(brand.name)}</strong>.</p>

<div class="grid dos">
  <form class="card" method="post" action="/action/crear-ahora">
    <div class="campo">
      <label for="tema">Qué querés decir</label>
      <textarea id="tema" name="tema" required placeholder="Ej: que el agente puede crear la base de datos solo, sin que toques Docker"></textarea>
      <div class="ayuda">Una idea concreta. Si le das un dato (un número, una feature), lo usa; si no, lo saca del conocimiento de la marca.</div>
    </div>
    <div class="grid dos">
      <div class="campo">
        <label for="format">Formato</label>
        <select id="format" name="format">
          ${formatos.map((f) => `<option value="${esc(f.k)}">${esc(f.k)} — ${esc(f.spec)}</option>`).join("")}
        </select>
      </div>
      <div class="campo">
        <label for="language">Idioma</label>
        <select id="language" name="language">
          ${idiomas.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="fila entre">
      ${
        hayTelegram
          ? `<label class="mini dim" style="display:flex;gap:6px;align-items:center;font-weight:500">
               <input type="checkbox" name="entregar" value="1" style="width:auto" checked> mandarla a Telegram cuando este lista
             </label>`
          : `<span class="mini faint">La pieza queda en el panel. <a href="/ajustes">Conecta Telegram</a> si la queres en el celular.</span>`
      }
      <button class="primario" type="submit" data-esperando="arrancando..." title="Genera la pieza ya mismo con la identidad de esta marca">Crear ahora</button>
    </div>
  </form>

  <div>
    ${
      enCurso.length
        ? `<div class="card">
             <h3><span class="vivo"></span> Generando ahora</h3>
             ${enCurso
               .map(
                 (j) => `<div style="margin:10px 0">
                   <a href="/item/${esc(j.item_id)}">${esc(j.angle ?? j.item_id)}</a>
                   <div class="mini dim">${esc(ETIQUETA_FASE[String(j.phase ?? "").split(" ")[0]] ?? j.phase ?? "trabajando")} · hace ${esc(j.silent_s ?? 0)}s del último latido</div>
                   <div class="barra" style="margin-top:6px"><i></i></div>
                 </div>`,
               )
               .join("")}
           </div>`
        : ""
    }
    <div class="card">
      <h3>Lo último que hiciste</h3>
      ${
        recientes.length
          ? `<table><tbody>${recientes
              .map(
                (i) => `<tr>
                  <td style="width:1%"><span class="mini faint mono">${esc(i.format)}</span></td>
                  <td><a href="/item/${esc(i.id)}">${esc(recorte(i.angle, 60))}</a></td>
                  <td style="width:1%">${chipDePieza(i, detenidos.has(i.id))}</td>
                </tr>`,
              )
              .join("")}</tbody></table>`
          : `<p class="dim mini">Nada todavía. Lo que crees acá aparece en esta lista.</p>`
      }
    </div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

export function vistaCalendario({ cfg, brand, dias, itemsPorDia, q, hoy, total, pendientes = 0, detenidos = new Set() }) {
  if (!brand) {
    return `<h1>Calendario</h1><p class="sub">Creá una marca para empezar a planificar.</p>
      <a class="boton primario" href="/marcas">Ir a marcas</a>`;
  }
  const cabecera = DOW.map((d) => `<div class="dow">${d}</div>`).join("");
  const celdas = dias
    .map((iso) => {
      const piezas = itemsPorDia.get(iso) ?? [];
      const esHoy = iso === hoy;
      return `<div class="dia${esHoy ? " hoy" : ""}">
        <div class="fecha">${esc(diaCorto(iso))}</div>
        ${piezas
          .map(
            (i) => `<a class="pieza" href="/item/${esc(i.id)}" title="${esc(i.angle)}">
              <span class="fmt">${esc(i.format)}${i.language ? ` · ${esc(i.language)}` : ""}</span><br>
              ${esc(recorte(i.angle, 46))}
              <div style="margin-top:4px">${chipDePieza(i, detenidos.has(i.id))}</div>
            </a>`,
          )
          .join("")}
      </div>`;
    })
    .join("");

  return `<div class="entre">
  <div>
    <h1>Calendario de ${esc(brand.name)}</h1>
    <p class="sub">${total} pieza(s) entre ${esc(humano(q.from))} y ${esc(humano(dias[dias.length - 1]))}</p>
  </div>
  <div class="fila">
    <a class="boton" href="/confirmar/plan?dias=14" title="Propone ángulos para las próximas dos semanas y los agenda. No genera nada.">Planificar 14 días</a>
    <a class="boton${pendientes ? " primario" : ""}" href="/confirmar/generar"
       title="${pendientes ? `Genera las ${pendientes} piezas pendientes de esta marca. Te muestra el costó antes de arrancar.` : "No hay piezas pendientes en este rango"}">
      Generar lo pendiente${pendientes ? ` <span class="chip">${pendientes}</span>` : ""}
    </a>
    <a class="boton" href="/nuevo" title="Agrega una pieza al calendario con la fecha que elijas">+ Agendar</a>
  </div>
</div>

<form method="get" action="/calendario" class="card fila" style="margin-bottom:16px">
  <div><label for="from">Desde</label><input type="date" id="from" name="from" value="${esc(q.from)}"></div>
  <div><label for="days">Días</label>
    <select id="days" name="days">${[7, 14, 30, 60].map((d) => `<option value="${d}"${d === q.days ? " selected" : ""}>${d}</option>`).join("")}</select>
  </div>
  <div><label for="status">Estado</label>
    <select id="status" name="status"><option value="">todos</option>
      ${Object.entries(ETIQUETA_ESTADO).map(([k, v]) => `<option value="${k}"${k === q.status ? " selected" : ""}>${esc(v)}</option>`).join("")}
    </select>
  </div>
  <div style="align-self:flex-end"><button type="submit" data-libre="1">Filtrar</button></div>
</form>

<div class="cal">${cabecera}</div>
<div class="cal" style="margin-top:6px">${celdas}</div>`;
}

// ---------------------------------------------------------------------------
// Marcas
// ---------------------------------------------------------------------------

export function vistaMarcas({ marcas, activa, creando }) {
  return `<h1>Marcas</h1>
<p class="sub">Cada marca tiene su paleta, su tipografía, su voz y sus fuentes de conocimiento. El contenido sale con esa identidad.</p>

${
  creando
    ? `<div class="card" data-vivo="/api/marcas"><h3><span class="vivo"></span> Creando una marca</h3>
       <p class="mini dim">${esc(creando)}</p><div class="barra"><i></i></div>
       <p class="mini faint">Tarda un minuto: se lee el sitio, se propone la identidad y se bajan las tipografías.
       Esta pagina se actualiza sola cuando termina.</p></div>`
    : ""
}

<div class="grid dos" style="margin-top:16px">
  <div>
    ${
      marcas.length
        ? marcas
            .map(
              (m) => `<div class="tarjeta-marca" style="margin-bottom:14px">
        ${muestraMarca(m)}
        <div class="pie entre">
          <div>
            <strong>${esc(m.name)}</strong>
            ${m.id === activa ? `<span class="chip built" style="margin-left:6px">activa</span>` : ""}
            <div class="mini faint">${esc(m.site ?? "sin sitio")} · rev ${esc(m.revision ?? 0)}</div>
          </div>
          <div class="fila">
            <a class="boton chico" href="/marcas/${esc(m.id)}" title="Ver su identidad, sus fuentes y su historial">Abrir</a>
            ${
              m.id === activa
                ? ""
                : `<form method="post" action="/action/marca-usar"><input type="hidden" name="brand" value="${esc(m.id)}"><button class="chico" type="submit" title="Trabajar sobre esta marca">Usar</button></form>`
            }
            <a class="boton chico peligro" href="/marcas/${esc(m.id)}/borrar" title="Borrar ${esc(m.name)}">Borrar</a>
          </div>
        </div>
      </div>`,
            )
            .join("")
        : `<div class="card"><p class="dim">Todavía no hay marcas.</p></div>`
    }
  </div>

  <form class="card" method="post" action="/action/marca-nueva">
    <h3>Nueva marca</h3>
    <div class="campo">
      <label for="url">Sitio de la marca</label>
      <input type="url" id="url" name="url" placeholder="https://tumarca.com">
      <div class="ayuda">De ahi salen los colores, el tono y los hechos que el contenido puede afirmar.</div>
    </div>
    <div class="campo">
      <label for="nombre">Nombre (opcional)</label>
      <input type="text" id="nombre" name="nombre" placeholder="Se toma del sitio si no lo pones">
    </div>
    <div class="campo">
      <label for="colores">Colores (opcional)</label>
      <input type="text" id="colores" name="colores" placeholder="#0C0F08, #C4EF3D">
      <div class="ayuda">Si los pones, mandan sobre los del sitio.</div>
    </div>
    <div class="campo">
      <label for="notas">Cómo querés que se sienta</label>
      <textarea id="notas" name="notas" placeholder="Ej: técnica y directa, público developer, nada de lenguaje corporativo"></textarea>
    </div>
    <button class="primario" type="submit" data-esperando="creando..." title="Lee el sitio, propone la identidad y baja las tipografías. Tarda cerca de un minuto.">Crear marca</button>
  </form>
</div>`;
}

export function vistaMarca({ brand, revisiones, fuentes, trabajando }) {
  const p = brand.palette ?? {};
  return `<div class="entre">
  <div>
    <h1>${esc(brand.name)}</h1>
    <p class="sub">${esc(brand.tagline ?? brand.audience ?? "")}</p>
  </div>
  <div class="fila">
    <form method="post" action="/action/marca-usar"><input type="hidden" name="brand" value="${esc(brand.id)}"><button type="submit" title="Trabajar sobre esta marca: lo que generes sale con su identidad">Usar esta marca</button></form>
    <a class="boton peligro chico" href="/marcas/${esc(brand.id)}/borrar" title="Borrar esta marca. Antes te muestra que se borra y que queda.">Borrar</a>
  </div>
</div>

${
  trabajando
    ? `<div class="card" data-vivo="/api/marcas"><h3><span class="vivo"></span> Trabajando</h3><div class="barra"><i></i></div>
       <p class="mini faint">${esc(trabajando)} — esta pagina se actualiza sola cuando termina.</p></div>`
    : ""
}

<div class="grid dos">
  <div class="tarjeta-marca">
    ${muestraMarca(brand, { alto: 220 })}
    <div class="pie">
      ${swatches(p)}
      <div class="mini faint" style="margin-top:8px">
        ${esc(brand.fonts?.display?.family ?? "—")} · ${esc(brand.fonts?.mono?.family ?? "—")} · revisión ${esc(brand.revision ?? 0)}
      </div>
    </div>
  </div>

  <form class="card" method="post" action="/action/marca-revisar">
    <input type="hidden" name="brand" value="${esc(brand.id)}">
    <h3>Cambiar algo</h3>
    <p class="mini dim">Decí qué no te gusta y se ajusta. La versión anterior queda guardada.</p>
    <div class="campo">
      <textarea name="feedback" required placeholder="Ej: más oscuro, el acento en violeta, la tipografía con menos personalidad"></textarea>
    </div>
    <button class="primario" type="submit" data-esperando="ajustando..." title="Ajusta la identidad y guarda la versión anterior como revision">Aplicar cambio</button>
  </form>
</div>

<h2>Identidad</h2>
<div class="card">
  <div class="grid dos">
    <div>
      <h3>Público</h3><p class="mini">${esc(brand.audience ?? "—")}</p>
      <h3>Voz</h3><p class="mini">${esc(brand.voice ?? "—")}</p>
    </div>
    <div>
      <h3>Como se escribe el nombre</h3><p class="mini">${esc(brand.nameUsage ?? "—")}</p>
      <h3>Nunca decir</h3><p class="mini">${(brand.never ?? []).map(esc).join(" · ") || "—"}</p>
      <h3>Idiomas</h3><p class="mini">${(brand.languages ?? []).map(esc).join(", ")} ${brand.languageMix ? `<span class="faint">(${esc(JSON.stringify(brand.languageMix))})</span>` : ""}</p>
    </div>
  </div>
</div>

<h2>De donde saca los hechos</h2>
<div class="card">
  ${
    fuentes.length
      ? `<table><thead><tr><th>Fuente</th><th>Tipo</th><th>Digest</th><th></th></tr></thead><tbody>
        ${fuentes
          .map(
            (f) => `<tr>
              <td><div>${esc(f.label ?? f.source_id)}</div><div class="mini faint">${esc(recorte(f.ref, 60))}</div></td>
              <td><span class="chip">${esc(f.kind)}</span></td>
              <td class="mini">${f.digest ? `${f.digest.length} chars · ${(f.facts ?? []).length} hechos` : `<span class="warn">sin sincronizar</span>`}</td>
              <td style="width:1%">
                <form method="post" action="/action/fuente-borrar" onsubmit="return confirm('Se quita ${esc(f.label ?? f.source_id)} de las fuentes de ${esc(brand.name)}. Los hechos que aporto dejan de estar disponibles para el contenido nuevo.')">
                  <input type="hidden" name="source" value="${esc(f.source_id)}">
                  <input type="hidden" name="brand" value="${esc(brand.id)}">
                  <button class="chico peligro" type="submit" title="Quitar esta fuente de conocimiento">Quitar</button>
                </form>
              </td>
            </tr>`,
          )
          .join("")}
      </tbody></table>`
      : `<p class="dim mini">Sin fuentes: el contenido no va a tener hechos que citar.</p>`
  }
  <div class="fila" style="margin-top:14px">
    <form method="post" action="/action/fuente-agregar" class="fila" style="flex:1">
      <input type="hidden" name="brand" value="${esc(brand.id)}">
      <input type="url" name="url" placeholder="https://otra-pagina-de-la-marca.com" style="flex:1">
      <button type="submit" title="Suma una URL de la que sacar hechos citables. Hay que sincronizar para leerla.">Agregar sitio</button>
    </form>
    <form method="post" action="/action/sync">
      <input type="hidden" name="brand" value="${esc(brand.id)}">
      <button type="submit" data-esperando="leyendo..." title="Relee las fuentes y actualiza los hechos que el contenido puede afirmar">Sincronizar</button>
    </form>
  </div>
</div>

${
  revisiones.length
    ? `<h2>Historial</h2><div class="card"><table><tbody>
      ${revisiones
        .map(
          (r) => `<tr>
            <td style="width:1%" class="mono mini">r${esc(r.revision)}</td>
            <td class="mini">${esc(r.feedback ?? "—")}</td>
            <td style="width:1%" class="mini faint">${esc(String(r.created_at ?? "").slice(0, 16))}</td>
          </tr>`,
        )
        .join("")}
    </tbody></table></div>`
    : ""
}

<h2>Sistema de diseño</h2>
<details class="card"><summary class="mini dim">frame.md — lo que lee el modelo al componer</summary>
<pre class="bloque mono" style="margin-top:12px">${esc(brand.frameMd ?? "(sin frame.md)")}</pre>
</details>`;
}

// ---------------------------------------------------------------------------
// Pieza
// ---------------------------------------------------------------------------

export function vistaItem({ item, brand, estado, media, cfg, hayTelegram = false, fallo = null, previa = null, bitacora = [] }) {
  const generando = estado.kind === "running";
  // Quedo en `building` pero no hay nadie generandola: el proceso murio (stale)
  // o se fue sin dejar rastro del trabajo (orphan). Decir "generando" ahi es
  // hacer esperar a alguien por algo que no va a pasar nunca.
  const detenido = estado.kind === "stale" || estado.kind === "orphan";
  return `<div class="entre">
  <div>
    <h1>${esc(item.angle)}</h1>
    <p class="sub">
      ${chipDePieza(item, estado)}
      · ${esc(item.format)} · ${esc(item.language)} · ${esc(item.scheduled_for)}
      ${brand ? `· <a href="/marcas/${esc(brand.id)}">${esc(brand.name)}</a>` : ""}
      ${item.revision ? `· revisión ${esc(item.revision)}` : ""}
    </p>
  </div>
  <a class="boton chico" href="/calendario">Volver</a>
</div>

${
  generando
    ? `<div class="card" data-vivo="/api/estado/${esc(item.id)}">
        <h3><span class="vivo"></span> <span data-campo="faseTexto">${esc(faseTexto(estado.job))}</span></h3>
        <div class="barra"><i></i></div>
        <p class="mini faint">Tarda minutos. Esta página se actualiza sola.</p>
      </div>`
    : ""
}
${detenido ? bloqueDetenido({ item, estado, fallo }) : ""}
${item.error ? `<div class="aviso mal"><strong>Último intento:</strong> ${esc(item.error)}</div>` : ""}
${bloqueBitacora({ item, bitacora, generando, detenido })}

<div class="grid dos">
  <div>
    ${media}
  </div>
  <div>
    <div class="card">
      <h3>Qué tiene que comunicar</h3>
      <p class="mini">${esc(item.message)}</p>
    </div>
    <div class="card">
      <h3>Acciones</h3>
      <div class="fila">
        <form method="post" action="/action/generar"><input type="hidden" name="id" value="${esc(item.id)}"><button type="submit" data-esperando="arrancando..." title="${generando ? "Ya se esta generando" : item.status === "planned" ? "Escribe el brief, compone y renderiza esta pieza" : "Vuelve a generarla desde cero con el mismo brief"}"${generando ? " disabled" : ""}>${item.status === "planned" ? "Generar" : "Regenerar"}</button></form>
        ${
          hayTelegram
            ? `<form method="post" action="/action/entregar"><input type="hidden" name="id" value="${esc(item.id)}"><button type="submit" title="${item.asset_path ? "Envia el archivo al chat configurado" : "Todavía no hay archivo que mandar"}"${item.asset_path ? "" : " disabled"}>Mandar a Telegram</button></form>`
            : ""
        }
        <form method="post" action="/action/aprobar"><input type="hidden" name="id" value="${esc(item.id)}"><button type="submit" title="La marca como buena. No genera ni envia nada.">Aprobar</button></form>
      </div>
      <form method="post" action="/action/rechazar" style="margin-top:14px">
        <input type="hidden" name="id" value="${esc(item.id)}">
        <label for="reason">Qué está mal</label>
        <textarea id="reason" name="reason" required placeholder="Ej: el titular suena a folleto; quiero el número de la latencia"></textarea>
        <button class="primario" type="submit" data-esperando="regenerando..." title="Descarta esta versión y genera otra teniendo en cuenta lo que escribiste. Vuelve a costar lo que costó generarla.">Rechazar y rehacer</button>
      </form>
    </div>
    <div class="card">
      <h3>Editar</h3>
      <form method="post" action="/action/editar">
        <input type="hidden" name="id" value="${esc(item.id)}">
        <div class="grid dos">
          <div class="campo"><label>Fecha</label><input type="date" name="scheduled_for" value="${esc(item.scheduled_for)}"></div>
          <div class="campo"><label>Idioma</label>
            <select name="language">${(brand?.languages ?? [item.language]).map((l) => `<option value="${esc(l)}"${l === item.language ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
          </div>
        </div>
        <div class="campo"><label>Ángulo</label><input type="text" name="angle" value="${esc(item.angle)}"></div>
        <div class="campo"><label>Mensaje</label><textarea name="message">${esc(item.message)}</textarea></div>
        <div class="fila entre">
          <button type="submit">Guardar</button>
          <a class="boton chico peligro" href="/borrar/${esc(item.id)}">Borrar pieza</a>
        </div>
      </form>
    </div>
  </div>
</div>

${
  item.brief
    ? `<h2>Brief</h2><details class="card"><summary class="mini dim">lo que el modelo decidio antes de componer</summary>
       <pre class="bloque mono" style="margin-top:12px">${esc(item.brief)}</pre></details>`
    : ""
}`;
}

/**
 * La bitácora de la última generación: lo mismo que se ve en la consola, línea
 * por línea y con su nivel, para que quien usa el panel sepa qué falló, qué se
 * reparó y por qué se detuvo. En vivo mientras corre (el JS de `data-vivo`
 * agrega las líneas nuevas que trae `/api/estado`) y persistente después.
 *
 * Abierta cuando hay algo pasando o algo salió mal; plegada cuando la pieza
 * salió bien y la bitácora es solo historia.
 */
function bloqueBitacora({ item, bitacora, generando, detenido }) {
  if (!bitacora.length && !generando) return "";
  const abierta = generando || detenido || Boolean(item.error) || item.status === "planned";
  const errores = bitacora.filter((l) => l.nivel === "error").length;
  const ultimo = bitacora.at(-1)?.id ?? 0;
  return `<details class="card"${abierta ? " open" : ""}>
  <summary class="mini dim">bitácora de la última generación${errores ? ` · <span class="err">${errores} error${errores === 1 ? "" : "es"}</span>` : ""}${generando ? " · en vivo" : ""}</summary>
  <p class="mini faint" style="margin:8px 0 6px">
    <span class="nivel-error">■</span> bloqueante: impide renderizar &nbsp;
    <span class="nivel-aviso">■</span> cosmético: el check pasa igual &nbsp;
    <span class="nivel-info">■</span> avance
  </p>
  <pre class="bloque bitacora" data-log data-log-desde="${ultimo}">${bitacora.map(lineaBitacora).join("")}</pre>
</details>`;
}

export function lineaBitacora(l) {
  const nivel = l.nivel === "error" || l.nivel === "aviso" ? l.nivel : "info";
  return `<div class="linea nivel-${nivel}"><span class="hora">${esc(horaCorta(l.created_at))}</span>${esc(l.texto)}</div>`;
}

/** "HH:MM:SS" de un datetime de SQLite (UTC), en hora local. */
function horaCorta(iso) {
  if (!iso) return "";
  const s = String(iso);
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

/**
 * El cartel de "esto no está corriendo".
 *
 * Existe porque la pieza que quedó a medias se veía igual que una que está
 * trabajando: el chip decía "generando" y la única diferencia era la ausencia
 * de la barra de progreso — una señal que hay que saber leer. Acá se dice con
 * todas las letras, con desde cuándo, dónde murió y qué hacer.
 */
function bloqueDetenido({ item, estado, fallo }) {
  const job = estado.job;
  const fase = job ? (ETIQUETA_FASE[String(job.phase ?? "").split(" ")[0]] ?? job.phase) : null;
  const hace = job?.silent_s ?? fallo?.hace_s ?? null;

  return `<div class="aviso mal">
  <div class="entre" style="gap:10px">
    <div>
      <strong>Esto no se está generando: se detuvo.</strong>
      <div class="mini" style="margin-top:4px">
        ${
          job
            ? `El proceso que la generaba (pid ${esc(job.pid)}) dejó de responder${hace != null ? ` hace ${esc(lapso(hace))}` : ""}${fase ? `, en la fase de <strong>${esc(fase)}</strong>` : ""}.`
            : `Quedó marcada como "generando" pero no hay ningún trabajo asociado: el proceso se fue sin poder limpiar.`
        }
        No hay nada esperándote: para seguir, hay que volver a arrancarla.
      </div>
      ${
        fallo?.detail
          ? `<div class="mini" style="margin-top:8px">Lo último que falló fue <code>${esc(fallo.kind)}</code>:
               <span class="mono">${esc(recorte(fallo.detail, 180))}</span></div>`
          : ""
      }
    </div>
    <form method="post" action="/action/generar">
      <input type="hidden" name="id" value="${esc(item.id)}">
      <button class="primario" type="submit" data-esperando="arrancando..."
              title="Vuelve a generarla desde el brief. Lo que ya estaba compuesto se reaprovecha.">Retomar</button>
    </form>
  </div>
</div>`;
}

/** Un lapso en segundos, dicho como lo diría una persona. */
function lapso(segundos) {
  const s = Number(segundos) || 0;
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h` : `${Math.round(h / 24)} dias`;
}

export function vistaCostos({ filas, dias, total }) {
  return `<h1>Costos</h1>
<p class="sub">Últimos ${dias} días. Se calcula con los precios de <code>brand-content-ai.config.json</code> a partir de los tokens que devuelve la API.</p>
<div class="card">
  <table>
    <thead><tr><th>Operacion</th><th>Llamadas</th><th style="text-align:right">USD</th></tr></thead>
    <tbody>
      ${filas
        .map(
          (r) => `<tr><td>${esc(r.kind)}</td><td>${esc(r.n)}</td><td style="text-align:right" class="mono">$${(r.usd ?? 0).toFixed(4)}</td></tr>`,
        )
        .join("")}
      <tr><td><strong>Total</strong></td><td></td><td style="text-align:right" class="mono"><strong>$${total.toFixed(4)}</strong></td></tr>
    </tbody>
  </table>
</div>`;
}

/**
 * Ajustes. Es la primera pantalla que ve alguien que acaba de clonar el repo:
 * sin API key no se genera nada, y pedirle que edite un .env por SSH es la
 * forma mas rápida de que abandone.
 */
export function vistaAjustes({ campos, grupos, pruebas = {}, hayEnv }) {
  const estado = (c) => {
    if (!c.definido) return `<span class="chip">sin definir</span>`;
    const donde = c.origen === "panel" ? "guardado aca" : "viene del .env";
    return `<span class="chip built">${esc(c.pista)}</span> <span class="mini faint">${donde}</span>`;
  };

  const campo = (c) => `<div class="campo">
      <label for="${esc(c.clave)}">${esc(c.label)} ${c.requerido ? '<span class="err">*</span>' : ""}</label>
      <div class="fila" style="align-items:flex-start">
        <input type="${c.secreto ? "password" : "text"}" id="${esc(c.clave)}" name="${esc(c.clave)}"
               placeholder="${esc(c.placeholder ?? (c.definido ? "sin cambios" : ""))}"
               value="${c.secreto ? "" : esc(c.origen === "panel" ? c.pista : "")}"
               autocomplete="off" style="flex:1;min-width:240px">
        <div style="padding-top:9px">${estado(c)}</div>
      </div>
      <div class="ayuda">${esc(c.ayuda ?? "")}${
        c.pisandoEnv ? ` <strong class="warn">Ojo: también esta en el .env con otro valor; manda este.</strong>` : ""
      }</div>
    </div>`;

  const normales = campos.filter((c) => !c.avanzado);
  const avanzados = campos.filter((c) => c.avanzado);
  const gruposVisibles = grupos.filter((g) => normales.some((c) => c.grupo === g.id));

  return `<h1>Ajustes</h1>
<p class="sub">Lo que pongas acá se guarda en la base y manda sobre el <code>.env</code>. Se aplica al instante: no hace falta reiniciar.</p>

${pruebas.msg ? `<div class="aviso ${pruebas.ok ? "bien" : "mal"}">${esc(pruebas.msg)}</div>` : ""}

<form method="post" action="/action/ajustes">
${gruposVisibles
  .map(
    (g) => `<h2>${esc(g.titulo)}</h2>
  <p class="sub">${esc(g.detalle)}</p>
  <div class="card">
    ${normales
      .filter((c) => c.grupo === g.id)
      .map(campo)
      .join("")}
    ${
      g.id === "telegram"
        ? `<div class="fila">
             <button type="submit" name="probar" value="telegram" data-esperando="probando...">Probar Telegram</button>
             <span class="mini faint">manda un mensaje de prueba al chat</span>
           </div>`
        : ""
    }
    ${
      g.id === "modelo"
        ? `<div class="fila">
             <button type="submit" name="probar" value="modelo" data-esperando="probando...">Probar el modelo</button>
             <span class="mini faint">una llamada corta para ver si la key anda</span>
           </div>`
        : ""
    }
  </div>`,
  )
  .join("")}

  ${
    avanzados.length
      ? `<details class="card" style="margin-top:18px">
           <summary class="mini dim">Opciones avanzadas — no hacen falta para trabajar</summary>
           <div style="margin-top:16px">${avanzados.map(campo).join("")}</div>
         </details>`
      : ""
  }

  <div class="fila" style="margin-top:20px">
    <button class="primario" type="submit" data-esperando="guardando...">Guardar</button>
    <span class="mini faint">Un campo vacío se deja como está. Para borrar un valor, escribi <code>-</code>.</span>
  </div>
</form>

${
  hayEnv
    ? `<p class="mini faint" style="margin-top:24px">También podes definirlos en <code>.env</code> (util para deploys automatizados). Lo de esta pantalla tiene prioridad.</p>`
    : ""
}`;
}

/** Cartel de "falta lo mínimo para trabajar", con el link para resolverlo. */
export function avisoSinModelo() {
  return `<div class="aviso mal">
    <strong>Falta la API key del modelo.</strong> Sin eso ${PRODUCTO} no puede escribir ni componer nada.
    <a href="/ajustes">Configurala en Ajustes</a>.
  </div>`;
}

/**
 * Contraseña y confirmacion, con boton para verla.
 *
 * Dos campos porque no hay recuperacion por email: una contraseña mal tipeada
 * al crear la cuenta deja a alguien afuera de su propia instalación. El boton
 * de ver existe por lo mismo — es mejor mirarla que adivinar por que no entra.
 * La comparacion se hace en el navegador (aviso inmediato) y otra vez en el
 * server, que es la que vale.
 */
function camposPassword({ ayuda = "" } = {}) {
  return `<div class="campo">
    <div class="entre" style="margin-bottom:6px">
      <label for="password" style="margin:0">Contraseña</label>
      <button type="button" class="chico" data-ver="password,password2" data-libre="1" style="padding:2px 8px;font-size:12px">ver</button>
    </div>
    <input type="password" id="password" name="password" required autocomplete="new-password">
    ${ayuda ? `<div class="ayuda">${esc(ayuda)}</div>` : ""}
  </div>
  <div class="campo">
    <label for="password2">Repetila</label>
    <input type="password" id="password2" name="password2" required autocomplete="new-password"
           data-igual-que="password" data-error="las dos contraseñas tienen que ser iguales">
    <div class="ayuda" data-aviso-de="password2"></div>
  </div>`;
}

/**
 * Primera corrida: no hay nadie todavia. Es la unica pantalla que se puede ver
 * sin cuenta, y crea al dueño.
 */
export function vistaSetup({ error, valores = {} } = {}) {
  return `<div class="portada">
  <div class="portada-marca">
    <span class="portada-punto"></span>
    <h1 class="portada-titulo">Crear tu cuenta</h1>
  </div>
  <p class="portada-linea">Es la primera vez que se abre este panel. La cuenta que crees ahora es la dueña: puede invitar al equipo y tocar los ajustes.</p>
  ${error ? `<div class="aviso mal">${esc(error)}</div>` : ""}
  <form method="post" action="/setup" class="portada-form">
    <div class="campo">
      <label for="name">Tu nombre</label>
      <input type="text" id="name" name="name" value="${esc(valores.name ?? "")}" placeholder="Como te ve el equipo" autofocus autocomplete="name">
    </div>
    <div class="campo">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" value="${esc(valores.email ?? "")}" placeholder="vos@tumarca.com" required autocomplete="username">
    </div>
    ${camposPassword({ ayuda: "Mínimo 10 caracteres. Una frase que recuerdes sirve mejor que un jeroglífico." })}
    <button class="primario" type="submit" style="width:100%;margin-top:4px">Crear cuenta y empezar</button>
  </form>
  <p class="portada-pie">Se guarda en la base de este servidor, con la contraseña hasheada. No sale de acá.</p>
</div>`;
}

/** Alta desde un link de invitación. */
export function vistaInvitacion({ invite, error, motivo, valores = {} } = {}) {
  if (!invite) {
    return `<div class="portada">
      <div class="portada-marca">
        <span class="portada-punto"></span>
        <h1 class="portada-titulo">Invitación no válida</h1>
      </div>
      <p class="portada-linea">${esc(motivo ?? "el link no sirve")}</p>
      <a class="boton" href="/login">Ir a la entrada</a>
    </div>`;
  }
  return `<div class="portada">
  <div class="portada-marca">
    <span class="portada-punto"></span>
    <h1 class="portada-titulo">Sumate al equipo</h1>
  </div>
  <p class="portada-linea">Te invitaron a este panel${invite.email ? ` como <strong>${esc(invite.email)}</strong>` : ""}. Elegí una contraseña y entrás.</p>
  ${error ? `<div class="aviso mal">${esc(error)}</div>` : ""}
  <form method="post" action="/invitacion/${esc(invite.token)}" class="portada-form">
    <div class="campo">
      <label for="name">Tu nombre</label>
      <input type="text" id="name" name="name" value="${esc(valores.name ?? "")}" autofocus autocomplete="name">
    </div>
    ${
      invite.email
        ? `<input type="hidden" name="email" value="${esc(invite.email)}">`
        : `<div class="campo"><label for="email">Email</label>
             <input type="email" id="email" name="email" value="${esc(valores.email ?? "")}" required autocomplete="username"></div>`
    }
    ${camposPassword({ ayuda: "Mínimo 10 caracteres." })}
    <button class="primario" type="submit" style="width:100%;margin-top:4px">Entrar</button>
  </form>
</div>`;
}

/** El equipo: quien entra, con que rol, y las invitaciones abiertas. */
export function vistaEquipo({ usuarios, invitaciones, yo, base, nuevoLink }) {
  const puede = yo.role === "owner";
  return `<h1>Equipo</h1>
<p class="sub">Quien puede entrar. Todos ven las mismas marcas y pueden generar y descargar contenido; solo el dueño invita, saca gente y toca los ajustes.</p>

${
  nuevoLink
    ? `<div class="aviso bien">
         <strong>Invitación lista.</strong> Pasale este link a la persona: vence en 7 días y sirve una sola vez.
         <div class="fila" style="margin-top:8px">
           <input type="text" readonly value="${esc(nuevoLink)}" onclick="this.select()" style="flex:1;min-width:280px">
         </div>
       </div>`
    : ""
}

<div class="card">
  <table>
    <thead><tr><th>Persona</th><th>Rol</th><th>Último ingreso</th><th></th></tr></thead>
    <tbody>
      ${usuarios
        .map(
          (u) => `<tr>
            <td><strong>${esc(u.name || u.email)}</strong>${u.id === yo.id ? " <span class=\"chip\">vos</span>" : ""}
                <div class="mini faint">${esc(u.email)}</div></td>
            <td>${u.role === "owner" ? "<span class=\"chip built\">dueño</span>" : "<span class=\"chip\">miembro</span>"}</td>
            <td class="mini faint">${esc(String(u.last_login ?? "nunca").slice(0, 16))}</td>
            <td style="width:1%">${
              puede && u.id !== yo.id
                ? `<form method="post" action="/action/usuario-borrar" onsubmit="return confirm('Se le corta el acceso ya mismo.')">
                     <input type="hidden" name="id" value="${esc(u.id)}">
                     <button class="chico peligro" type="submit" title="Le corta el acceso al panel ya mismo">Sacar</button>
                   </form>`
                : ""
            }</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>
</div>

${
  puede
    ? `<h2>Invitar a alguien</h2>
       <form class="card fila" method="post" action="/action/invitar">
         <input type="text" name="email" placeholder="email de la persona (opcional)" style="flex:1;min-width:240px">
         <select name="role" style="width:auto">
           <option value="member">miembro</option>
           <option value="owner">dueño</option>
         </select>
         <button class="primario" type="submit" title="Crea un link de un solo uso que vence en 7 días">Generar link</button>
       </form>
       ${
         invitaciones.length
           ? `<div class="card"><h3>Invitaciones abiertas</h3>
              <table><tbody>${invitaciones
                .map(
                  (i) => `<tr>
                    <td class="mini">${esc(i.email ?? "cualquiera con el link")}</td>
                    <td class="mini faint">${esc(i.role)}</td>
                    <td class="mini faint">vence ${esc(String(i.expires_at).slice(0, 10))}</td>
                    <td class="mini"><input type="text" readonly value="${esc(base)}/invitacion/${esc(i.token)}" onclick="this.select()" style="width:100%"></td>
                    <td style="width:1%"><form method="post" action="/action/invitacion-borrar" onsubmit="return confirm('El link deja de servir. Si ya se lo pasaste a alguien, no va a poder entrar.')">
                      <input type="hidden" name="token" value="${esc(i.token)}">
                      <button class="chico peligro" type="submit" title="Anular esta invitacion">Anular</button>
                    </form></td>
                  </tr>`,
                )
                .join("")}</tbody></table></div>`
           : ""
       }`
    : ""
}

<h2>Tu cuenta</h2>
<form class="card" method="post" action="/action/mi-cuenta">
  <div class="grid dos">
    <div class="campo"><label>Nombre</label><input type="text" name="name" value="${esc(yo.name ?? "")}"></div>
    <div class="campo"><label>Email</label><input type="text" value="${esc(yo.email)}" disabled></div>
  </div>
  <div class="grid dos">
    <div class="campo"><label>Contraseña nueva</label><input type="password" name="password" placeholder="vacío = no la cambies"></div>
    <div class="campo"><label>Contraseña actual</label><input type="password" name="actual" placeholder="hace falta para cambiarla"></div>
  </div>
  <button type="submit">Guardar</button>
</form>`;
}

/**
 * El tour, como asistente: una tarjeta a la vez.
 *
 * La primera versión mostraba los cuatro pasos apilados con sus formularios
 * abiertos y era un muro. Acá se ve UNA cosa, se hace, y se pasa a la
 * siguiente — que es como se lee algo que no conoces.
 *
 * El estado de cada paso se calcula del sistema real, así que el asistente se
 * puede recorrer de nuevo cuando quieras: los pasos ya hechos se ven hechos.
 */
export function vistaEmpezar({ pasos, indice, brand }) {
  const total = pasos.length;
  const paso = pasos[Math.min(Math.max(indice, 0), total - 1)];
  const n = pasos.indexOf(paso);
  const anterior = n > 0 ? n - 1 : null;
  const siguiente = n < total - 1 ? n + 1 : null;

  const puntos = pasos
    .map((x, k) => {
      const estado = x.hecho ? "background:var(--ok)" : k === n ? "background:var(--acento)" : "background:var(--line-fuerte)";
      return `<a href="/empezar?paso=${k}" title="${esc(x.titulo)}" style="width:${k === n ? 26 : 9}px;height:9px;border-radius:99px;${estado};display:inline-block;transition:width .15s"></a>`;
    })
    .join("");

  return `<div style="max-width:620px;margin:4vh auto 0">
  <div class="fila" style="gap:6px;justify-content:center;margin-bottom:6px">${puntos}</div>
  <p class="mini faint" style="text-align:center;margin-bottom:18px">paso ${n + 1} de ${total}</p>

  <div class="card" style="padding:28px">
    ${paso.hecho ? '<span class="chip built" style="margin-bottom:12px">ya está listo</span>' : ""}
    <h1 style="font-size:24px;margin-bottom:10px">${esc(paso.titulo)}</h1>
    <div class="sub" style="margin-bottom:20px">${paso.detalle}</div>

    ${paso.hecho && paso.resumen ? `<div class="aviso bien" style="margin-bottom:18px">${paso.resumen}</div>` : ""}
    ${!paso.hecho && paso.cuerpo ? paso.cuerpo : ""}
    ${paso.hecho && siguiente !== null ? `<a class="boton primario" href="/empezar?paso=${siguiente}">Seguir</a>` : ""}
    ${paso.final ? `<a class="boton primario" href="/crear">Crear mi primera pieza</a>` : ""}
  </div>

  <div class="entre" style="margin-top:14px">
    <div>${anterior !== null ? `<a class="boton chico" href="/empezar?paso=${anterior}">&larr; Atras</a>` : ""}</div>
    <div class="fila">
      ${
        !paso.hecho && !paso.final && siguiente !== null
          ? `<a class="mini faint" href="/empezar?paso=${siguiente}">saltar por ahora</a>`
          : ""
      }
      <a class="mini faint" href="/crear">salir del asistente</a>
      <form method="post" action="/action/tour-listo">
        <button class="chico" type="submit" title="El asistente deja de aparecer al entrar. Vas a poder volver a el desde /empezar.">No mostrarlo mas</button>
      </form>
    </div>
  </div>
</div>`;
}

/**
 * La entrada.
 *
 * Es la única pantalla del panel donde todavía no hay marca, así que no tiene
 * nada que mostrar salvo su propio nombre: el trabajo lo hacen la tipografía,
 * el aire y una sola columna angosta. Sin tarjeta flotando en el medio de la
 * nada — el formulario se apoya en la página, que es lo que hace que se lea
 * como una puerta y no como un cuadro de diálogo.
 */
export function vistaLogin({ error, email = "", modoClave = false } = {}) {
  return `<div class="portada">
  <div class="portada-marca">
    <span class="portada-punto"></span>
    <h1 class="portada-titulo">${esc(PRODUCTO)}</h1>
  </div>
  <p class="portada-linea">${
    modoClave
      ? "Esta instalación usa una clave compartida."
      : "Contenido con la identidad de tu marca."
  }</p>

  ${error ? `<div class="aviso mal">${esc(error)}</div>` : ""}

  <form method="post" action="/login" class="portada-form">
    ${
      modoClave
        ? `<div class="campo">
             <label for="clave">Clave del panel</label>
             <input type="password" id="clave" name="clave" autofocus required autocomplete="current-password">
           </div>`
        : `<div class="campo">
             <label for="email">Email</label>
             <input type="email" id="email" name="email" value="${esc(email)}" autofocus required
                    autocomplete="username" placeholder="vos@tumarca.com">
           </div>
           <div class="campo">
             <label for="password">Contraseña</label>
             <input type="password" id="password" name="password" required autocomplete="current-password">
           </div>`
    }
    <button class="primario" type="submit" style="width:100%;margin-top:4px">Entrar</button>
  </form>

  ${
    modoClave
      ? ""
      : `<p class="portada-pie">¿Perdiste la contraseña? No hay recuperación por email: pedile al dueño del panel una invitación nueva.</p>`
  }
</div>`;
}

export function vistaNueva({ cfg, brand, hoy }) {
  const formatos = Object.keys(cfg.formats ?? {}).filter((k) => cfg.formats[k]?.enabled !== false);
  return `<h1>Agendar una pieza</h1>
<p class="sub">Va al calendario de ${esc(brand?.name ?? "—")} con la fecha que elijas. Para algo ya mismo, usa <a href="/crear">Crear</a>.</p>
<form class="card" method="post" action="/action/crear">
  <div class="grid dos">
    <div class="campo"><label for="scheduled_for">Fecha</label><input type="date" id="scheduled_for" name="scheduled_for" value="${esc(hoy)}" required></div>
    <div class="campo"><label for="format">Formato</label>
      <select id="format" name="format">${formatos.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("")}</select>
    </div>
  </div>
  <div class="campo"><label for="language">Idioma</label>
    <select id="language" name="language">${(brand?.languages ?? ["en"]).map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}</select>
  </div>
  <div class="campo"><label for="angle">Ángulo</label><input type="text" id="angle" name="angle" required placeholder="el gancho, en una linea"></div>
  <div class="campo"><label for="message">Mensaje</label><textarea id="message" name="message" required placeholder="qué tiene que quedarle a quien lo ve"></textarea></div>
  <button class="primario" type="submit">Agendar</button>
</form>`;
}

export function vistaBorrar({ item }) {
  return `<h1>Borrar la pieza</h1>
<p class="sub">${esc(item.angle)}</p>
<div class="card">
  <p>Se borra del calendario y con ella su historial de revisiones. El archivo generado en disco no se toca.</p>
  <form method="post" action="/action/borrar" class="fila">
    <input type="hidden" name="id" value="${esc(item.id)}">
    <button class="peligro" type="submit">Si, borrar</button>
    <a class="boton" href="/item/${esc(item.id)}">Cancelar</a>
  </form>
</div>`;
}

/**
 * Antes de borrar una marca: que se va, que queda y que hay en disco.
 *
 * Borrar la marca no borra sus piezas — quedan huerfanas a proposito, porque el
 * contenido generado es trabajo pagado. Pero eso hay que decirlo, y hay que
 * ofrecer la otra opción: si borras la marca porque fue una prueba, lo que
 * queres es que no quede nada.
 */
export function vistaBorrarMarca({ brand, piezas, fuentes, archivos, bytes }) {
  return `<h1>Borrar ${esc(brand.name)}</h1>
<p class="sub">${esc(brand.site ?? "sin sitio")} · revisión ${esc(brand.revision ?? 0)}</p>

<div class="grid dos">
  <div class="card">
    <h3>Qué pasa</h3>
    <table><tbody>
      <tr><td>La marca y su identidad</td><td style="width:1%"><span class="chip mal">se borra</span></td></tr>
      <tr><td>Su historial de revisiones</td><td><span class="chip mal">se borra</span></td></tr>
      <tr><td>${fuentes} fuente(s) de conocimiento</td><td><span class="chip mal">se borra</span></td></tr>
      <tr><td>${piezas} pieza(s) del calendario</td><td><span class="chip">quedan sin marca</span></td></tr>
    </tbody></table>
    <p class="mini faint" style="margin-top:10px">Las piezas ya generadas se conservan: cuestan plata y borrarlas por tocar "eliminar marca" seria una sorpresa cara. Las vas a seguir viendo en el calendario, sin marca asociada.</p>
  </div>

  <div class="card">
    <h3>Los archivos en disco</h3>
    ${
      archivos
        ? `<p class="mini">Esta marca dejo <strong>${archivos} carpeta(s)</strong>${bytes ? ` (${tamaño(bytes)})` : ""}: su proyecto base y el de cada pieza que genero.</p>
           <label class="mini" style="display:flex;gap:8px;align-items:flex-start;font-weight:500;margin-top:12px">
             <input type="checkbox" name="archivos" value="1" form="borrar-marca" style="width:auto;margin-top:3px">
             <span>Borrar también esas carpetas.<br>
               <span class="faint">Solo se tocan las carpetas de proyectos y de contenido de esta instalación. Los videos e imágenes que ya descargaste no están ahí.</span></span>
           </label>`
        : `<p class="mini faint">Esta marca no dejo archivos en disco.</p>`
    }
  </div>
</div>

<form method="post" action="/action/marca-borrar" class="fila" id="borrar-marca" style="margin-top:18px">
  <input type="hidden" name="brand" value="${esc(brand.id)}">
  <button class="peligro" type="submit" title="Borra la marca. No se puede deshacer.">Si, borrar ${esc(brand.name)}</button>
  <a class="boton" href="/marcas/${esc(brand.id)}">Cancelar</a>
</form>`;
}

/** Un tamaño en bytes, redondeado como lo diria una persona. */
function tamaño(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Antes de generar en lote: que piezas, de que marca, cuanto cuesta.
 *
 * El boton decia "Generar lo pendiente" y arrancaba hasta 20 piezas sin decir
 * cuantas ni de que. Con los precios reales de esta instalación un carrusel
 * puede costar mas de veinte dólares, así que el número tiene que estar antes
 * del click y no después, en la pantalla de costos.
 */
export function vistaConfirmarGenerar({ brand, piezas, estimacion, limite, concurrencia }) {
  if (!piezas.length) {
    return `<h1>No hay nada pendiente</h1>
<p class="sub">Todas las piezas de ${esc(brand.name)} ya se generaron o están en curso.</p>
<a class="boton" href="/calendario">Volver al calendario</a>`;
  }

  const recortado = piezas.length > limite;
  const aGenerar = piezas.slice(0, limite);
  const porFormato = new Map();
  for (const p of aGenerar) porFormato.set(p.format, (porFormato.get(p.format) ?? 0) + 1);

  const conDato = [...porFormato.keys()].filter((f) => estimacion[f]);
  const sinDato = [...porFormato.keys()].filter((f) => !estimacion[f]);
  const usdTotal = conDato.reduce((a, f) => a + estimacion[f].usd * porFormato.get(f), 0);
  const msTotal = conDato.reduce((a, f) => a + estimacion[f].ms * porFormato.get(f), 0);

  return `<h1>Generar ${aGenerar.length} pieza${aGenerar.length === 1 ? "" : "s"} de ${esc(brand.name)}</h1>
<p class="sub">Esto le pide al modelo que escriba, componga y renderice cada una. Mira el número antes de arrancar: se paga por token generado y no se puede deshacer.</p>

<div class="grid dos">
  <div class="card">
    <h3>Lo que va a generar</h3>
    <table>
      <thead><tr><th>Formato</th><th>Piezas</th><th style="text-align:right">USD estimado</th></tr></thead>
      <tbody>
        ${[...porFormato.entries()]
          .map(([f, n]) => {
            const e = estimacion[f];
            return `<tr>
              <td class="mono">${esc(f)}</td>
              <td>${n}</td>
              <td style="text-align:right" class="mono">${
                e
                  ? `$${(e.usd * n).toFixed(2)}`
                  : `<span class="faint" title="Todavía no se genero ninguna pieza de este formato">sin dato</span>`
              }</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    ${
      conDato.length
        ? `<div class="aviso ${usdTotal >= 10 ? "mal" : "bien"}" style="margin:14px 0 0">
             <strong>Estimado: $${usdTotal.toFixed(2)}</strong>
             · ${duracion(msTotal)} de trabajo del modelo
             ${
               concurrencia > 1
                 ? `<div class="mini" style="margin-top:4px">El reloj real es menor: se generan ${concurrencia} piezas a la vez.</div>`
                 : ""
             }
             ${
               sinDato.length
                 ? `<div class="mini" style="margin-top:4px">No incluye ${esc(sinDato.join(", "))}: nunca se genero una pieza de ${sinDato.length === 1 ? "ese formato" : "esos formatos"}.</div>`
                 : ""
             }
           </div>`
        : `<div class="aviso" style="margin:14px 0 0">
             <strong>Sin estimacion.</strong> Esta instalación todavía no genero ninguna pieza de estos formatos, así que no hay historial con que calcular el costó.
           </div>`
    }
    <p class="mini faint" style="margin-top:10px">Sale del promedio real de esta instalación, formato por formato. Lo ya gastado está en <a href="/costos">Costos</a>.</p>
  </div>

  <div class="card">
    <h3>Una por una</h3>
    <table><tbody>
      ${aGenerar
        .map(
          (p) => `<tr>
            <td style="width:1%" class="mini faint mono">${esc(p.scheduled_for)}</td>
            <td style="width:1%"><span class="mini faint mono">${esc(p.format)}</span></td>
            <td class="mini"><a href="/item/${esc(p.id)}">${esc(recorte(p.angle, 52))}</a></td>
          </tr>`,
        )
        .join("")}
    </tbody></table>
    ${
      recortado
        ? `<p class="mini warn" style="margin-top:10px">Hay ${piezas.length} pendientes y se generan ${limite} por vez. Las ${piezas.length - limite} restantes quedan para la próxima.</p>`
        : ""
    }
  </div>
</div>

<form method="post" action="/action/generar-pendientes" class="fila" style="margin-top:18px">
  <input type="hidden" name="brand" value="${esc(brand.id)}">
  <button class="primario" type="submit" data-esperando="arrancando...">Generar ${aGenerar.length} pieza${aGenerar.length === 1 ? "" : "s"}</button>
  <a class="boton" href="/calendario">Cancelar</a>
</form>`;
}

/**
 * Antes de planificar: cuantas piezas se agregan al calendario y con que mezcla.
 * Planificar no cuesta casi nada, pero llena el calendario — y lo que llena el
 * calendario es lo que después se genera.
 */
export function vistaConfirmarPlan({ brand, dias, porSemana, mezcla, yaHay, desde, hasta }) {
  const total = Math.round((dias / 7) * porSemana);
  return `<h1>Planificar ${dias} días de ${esc(brand.name)}</h1>
<p class="sub">El modelo propone los ángulos y los reparte en el calendario. No genera nada todavia: las piezas quedan pendientes y las generas cuando quieras.</p>

<div class="card">
  <h3>Lo que va a agregar</h3>
  <p>Cerca de <strong>${total} pieza${total === 1 ? "" : "s"}</strong> entre el ${esc(desde)} y el ${esc(hasta)}, a razon de ${porSemana} por semana.</p>
  ${
    mezcla.length
      ? `<div class="fila" style="margin-top:10px">${mezcla
          .map(([f, n]) => `<span class="chip">${esc(f)} · ${n}/semana</span>`)
          .join("")}</div>`
      : ""
  }
  ${
    yaHay
      ? `<div class="aviso" style="margin:14px 0 0">Ya hay ${yaHay} pieza(s) en ese rango. Las nuevas se suman: no se pisa ni se borra nada.</div>`
      : ""
  }
</div>

<form method="post" action="/action/plan" class="fila" style="margin-top:18px">
  <input type="hidden" name="dias" value="${esc(dias)}">
  <input type="hidden" name="brand" value="${esc(brand.id)}">
  <button class="primario" type="submit" data-esperando="planificando...">Planificar ${dias} días</button>
  <a class="boton" href="/calendario">Cancelar</a>
</form>`;
}

/** Un lapso en ms, dicho como lo diria una persona. */
function duracion(ms) {
  const min = Math.round(Number(ms) / 60000);
  if (!Number.isFinite(min) || min <= 0) return "menos de un minuto";
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `~${h} h ${r} min` : `~${h} h`;
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

export function faseTexto(job) {
  if (!job) return "trabajando";
  const clave = String(job.phase ?? "").split(" ")[0];
  const base = ETIQUETA_FASE[clave] ?? job.phase ?? "trabajando";
  const detalle = String(job.phase ?? "").split(" ")[1];
  return detalle ? `${base} (${detalle})` : base;
}

function describirFormato(k, f) {
  switch (k) {
    case "text":
      return `post de hasta ${f.maxChars ?? 600} caracteres`;
    case "image":
      return `imagen ${f.aspect ?? ""}`;
    case "story":
      return `historia vertical ${f.aspect ?? "1080x1920"}`;
    case "carousel":
      return `${f.slides ?? 6} slides ${f.aspect ?? ""}`;
    case "video":
      return `video de ${f.lengthSeconds ?? 40}s`;
    case "reel":
      return `reel vertical de ${f.lengthSeconds ?? 20}s`;
    default:
      // Un formato que agregaste vos: se describe con lo que declara.
      return [f.aspect, f.lengthSeconds ? `${f.lengthSeconds}s` : "", f.slides ? `${f.slides} slides` : ""]
        .filter(Boolean)
        .join(" · ") || k;
  }
}

function recorte(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function diaCorto(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DOW[dt.getDay()]} ${d} ${MES[m - 1]}`;
}

function humano(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return `${d} ${MES[m - 1]} ${y}`;
}
