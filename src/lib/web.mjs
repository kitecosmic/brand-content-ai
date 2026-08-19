// El panel de Brand Content AI.
//
// Cuatro pestanas y una idea por pestana:
//   Crear      — deci que queres decir y sale ahora
//   Calendario — lo planificado, de la marca activa
//   Marcas     — crear una identidad desde una URL e iterarla hasta que guste
//   Costos     — cuanto se gasto
//
// Decisiones que explican la forma del archivo:
//
// - Todo se lee de la base en cada request. Nada se cachea: si dice "generando"
//   es porque hay un job con latido reciente, y se ve igual si la corrida se
//   lanzo desde otra terminal.
// - El HTML se arma en el server (views.mjs) y el unico JS es el nuestro
//   (ui.mjs): sin build, sin node_modules; se sube a un servidor con node y ya.
// - Se puede publicar: con BCA_PANEL_PASSWORD hay login con cookie firmada.
//   Sin clave, el server se niega a escuchar fuera de 127.0.0.1 — un panel
//   abierto es la tarjeta de credito de cualquiera que pase.

import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { addDays, env, loadConfig, slugify, today } from "./config.mjs";
import { CAMPOS, GRUPOS, estadoAjustes, guardarAjuste, telegramConfigurado, modeloConfigurado } from "./settings.mjs";
import {
  aceptarInvitacion,
  autenticar,
  crearCuenta,
  crearInvitacion,
  esUltimoOwner,
  firmarSesion,
  hayCuentas,
  hashPassword,
  revisarInvitacion,
  usuarioDeSesion,
  validarPassword,
  verifyPassword,
  AuthError,
} from "./auth.mjs";
import { STATUSES } from "./store.mjs";
import { esc, fuentesDeMarca, pagina, TEMAS } from "./ui.mjs";
import {
  ETIQUETA_ESTADO,
  avisoSinModelo,
  faseTexto,
  vistaAjustes,
  vistaEmpezar,
  vistaEquipo,
  vistaInvitacion,
  vistaSetup,
  vistaBorrar,
  vistaBorrarMarca,
  vistaConfirmarGenerar,
  vistaConfirmarPlan,
  vistaCalendario,
  vistaCostos,
  vistaCrear,
  vistaItem,
  vistaLogin,
  vistaMarca,
  vistaMarcas,
  vistaNueva,
} from "./views.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const DIAS_DEFECTO = 14;
const MAX_DIAS = 92;
// Cuantas piezas genera de una el boton "Generar lo pendiente".
const LOTE_PENDIENTES = 20;
// Marca en el kv de que alguien ya recorrio el asistente y no quiere verlo mas.
const TOUR_VISTO = "ui:tour-visto";
const STALE_SECONDS = 120;
const MAX_ANGLE = 300;
const MAX_MESSAGE = 2000;
const SESION_HORAS = 24 * 14;

export function startWeb(cfg, store, handlers = {}, { port, host, log } = {}) {
  const listenPort = Number(port ?? cfg.web?.port ?? 4317);
  const listenHost = String(host ?? cfg.web?.host ?? "127.0.0.1");
  // La clave se relee en cada request: si la cambias desde Ajustes, tiene
  // efecto sin reiniciar el panel.
  const clavePanel = () => env("PANEL_PASSWORD");
  const esLocal = listenHost === "127.0.0.1" || listenHost === "localhost" || listenHost === "::1";

  // Publicar sin ninguna forma de autenticacion es regalarle la API key a quien
  // pase. Con cuentas creadas alcanza: la primera corrida obliga a crear una.
  if (!esLocal && !clavePanel() && !hayCuentas(store)) {
    throw new Error(
      `el panel no se publica sin cuentas ni clave: pusiste host ${listenHost} y esta instalacion no tiene ninguna de las dos.
  opcion 1: levantalo en 127.0.0.1, crea tu cuenta y despues publicalo
  opcion 2: BCA_PANEL_PASSWORD=algo-largo-y-random en el .env`,
    );
  }


  // Secreto de sesion: si no lo definis, se inventa uno por arranque. Reiniciar
  // el panel cierra las sesiones abiertas, que es un precio barato por no
  // dejar un secreto en disco sin que nadie lo haya pedido.
  const secreto = env("SESSION_SECRET") || randomBytes(32).toString("hex");
  const staleSeconds = Math.max(5, Number(cfg.limits?.jobStaleSeconds ?? STALE_SECONDS));

  // Lo que lanzo ESTE panel. La verdad de "se esta generando" es la tabla jobs;
  // esto cubre la ventana entre que se aprieta el boton y que aparece la fila.
  const running = new Map();

  const server = createServer(async (req, res) => {
    try {
      await rutear(req, res);
    } catch (err) {
      log?.(`[web] ${err?.stack ?? err}`);
      enviar(
        res,
        500,
        "text/html; charset=utf-8",
        pagina({
          titulo: "Error",
          cuerpo: `<h1>Se rompio algo</h1><pre class="bloque">${esc(err?.message ?? err)}</pre>`,
          autenticado: false,
        }),
      );
    }
  });

  // -------------------------------------------------------------------------
  // Ruteo
  // -------------------------------------------------------------------------

  async function rutear(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const ruta = decodeURIComponent(url.pathname);
    const cookies = leerCookies(req);
    const tema = TEMAS.includes(cookies.bca_tema) ? cookies.bca_tema : "auto";

    // --- quien sos ---------------------------------------------------------
    //
    // Tres modos, en este orden:
    //   1. hay cuentas  -> login con email y contrasena (lo normal)
    //   2. no hay cuentas pero si BCA_PANEL_PASSWORD -> clave unica, como
    //      antes: una instalacion que ya venia configurada asi sigue andando
    //   3. no hay nada  -> primera corrida: se crea la cuenta duena
    const conCuentas = hayCuentas(store);
    const clave = clavePanel();
    const modoClave = !conCuentas && !!clave;
    const yo = conCuentas ? usuarioDeSesion(store, secreto, cookies.bca_sesion) : null;

    if (ruta === "/salir") {
      res.writeHead(303, { location: "/login", "set-cookie": galleta(esHttps(req), "bca_sesion", "", 0) });
      return res.end();
    }

    // La invitacion se abre sin sesion: es como entra alguien nuevo.
    if (ruta.startsWith("/invitacion/")) {
      const token = decodeURIComponent(ruta.slice("/invitacion/".length));
      if (req.method === "POST") return await postInvitacion(req, res, token, tema);
      const chequeo = revisarInvitacion(store, token);
      return enviar(
        res,
        chequeo.ok ? 200 : 404,
        "text/html; charset=utf-8",
        pagina({
          titulo: "Invitacion",
          cuerpo: vistaInvitacion(chequeo.ok ? { invite: chequeo.invite } : { motivo: chequeo.motivo }),
          tema,
          autenticado: false,
        }),
      );
    }

    if (!conCuentas && !modoClave) {
      // Primera corrida: no hay nadie. Todo lleva a crear la cuenta.
      if (ruta === "/setup" && req.method === "POST") return await postSetup(req, res, tema);
      if (ruta !== "/setup") {
        res.writeHead(303, { location: "/setup" });
        return res.end();
      }
      return enviar(
        res,
        200,
        "text/html; charset=utf-8",
        pagina({ titulo: "Crear tu cuenta", cuerpo: vistaSetup({}), tema, autenticado: false }),
      );
    }

    if (ruta === "/setup") {
      res.writeHead(303, { location: conCuentas ? "/crear" : "/login" });
      return res.end();
    }

    if (ruta === "/login") {
      if (req.method === "POST") return await postLogin(req, res, tema, { modoClave });
      return enviar(
        res,
        200,
        "text/html; charset=utf-8",
        pagina({ titulo: "Entrar", cuerpo: vistaLogin({ modoClave }), tema, autenticado: false }),
      );
    }

    const autorizado = conCuentas ? !!yo : sesionValida(cookies.bca_sesion);
    if (!autorizado) {
      res.writeHead(303, { location: "/login" });
      return res.end();
    }
    // En modo clave no hay identidad: se trata como duenio para no romper nada.
    const usuario = yo ?? { id: "clave", email: "", name: "panel", role: "owner" };

    if (req.method === "GET" && ruta.startsWith("/asset/")) {
      return servirAsset(res, ruta.slice("/asset/".length));
    }
    if (req.method === "GET" && ruta.startsWith("/preview/")) {
      return servirPreview(res, ruta.slice("/preview/".length));
    }
    if (req.method === "GET" && /^\/marca\/[^/]+\/fuentes\.css$/.test(ruta)) {
      return servirFuentes(res, decodeURIComponent(ruta.split("/")[2]));
    }
    if (req.method === "GET" && ruta === "/api/marcas") {
      // La pagina de Marcas se quedaba con el cartel "creando..." para siempre:
      // el trabajo termina en el server y el navegador no se enteraba.
      const trabajando = [...running.keys()].some((k) => k.startsWith("__marca") || k.startsWith("__sync"));
      return enviar(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ trabajando, recargar: !trabajando }),
      );
    }
    if (req.method === "GET" && ruta.startsWith("/api/estado/")) {
      return apiEstado(res, ruta.slice("/api/estado/".length), { desde: url.searchParams.get("desde") });
    }

    if (req.method === "POST") {
      if (!mismoOrigen(req)) return enviar(res, 403, "text/plain; charset=utf-8", "origen no permitido");
      const params = new URLSearchParams(await leerCuerpo(req));
      if (ruta.startsWith("/action/")) {
        return await accion(res, ruta.slice("/action/".length), params, {
          usuario,
          base: baseUrl(req),
          // El selector de arriba guarda la marca en una cookie. Sin pasarla,
          // las acciones caian en la marca por defecto de la base: pedias una
          // pieza para la marca que estabas mirando y se generaba con la
          // identidad de otra.
          marcaCookie: cookies.bca_marca,
          // Las cookies que escriba esta accion se marcan Secure si la request
          // llego por TLS. Aca no hay req: por eso viaja el dato ya resuelto.
          seguro: esHttps(req),
        });
      }
      return enviar(res, 404, "text/plain; charset=utf-8", "no encontrado");
    }

    const marcaActiva = resolverMarca(cookies.bca_marca);
    const marco = {
      tema,
      marcas: store.listBrands(),
      marcaActiva: marcaActiva?.id ?? "",
      msg: url.searchParams.get("msg") ?? "",
      err: url.searchParams.get("err") ?? "",
      usuario,
      base: baseUrl(req),
      faltaEmpezar: faltaOnboarding(),
    };

    if (ruta === "/" || ruta === "/crear") return vistaDeCrear(res, marco, marcaActiva);
    if (ruta === "/calendario") return vistaDeCalendario(res, marco, marcaActiva, url);
    if (ruta === "/marcas") return vistaDeMarcas(res, marco, marcaActiva);
    if (/^\/marcas\/[^/]+\/borrar$/.test(ruta)) {
      return vistaDeBorrarMarca(res, marco, decodeURIComponent(ruta.split("/")[2]));
    }
    if (ruta.startsWith("/marcas/")) return vistaDeMarca(res, marco, ruta.slice("/marcas/".length));
    if (ruta === "/nuevo") return vistaDeNueva(res, marco, marcaActiva);
    if (ruta === "/confirmar/generar") return vistaDeConfirmarGenerar(res, marco, marcaActiva);
    if (ruta === "/confirmar/plan") return vistaDeConfirmarPlan(res, marco, marcaActiva, url);
    if (ruta === "/empezar") return vistaDeEmpezar(res, marco, marcaActiva);
    if (ruta === "/equipo") return vistaDeEquipo(res, marco, usuario, url);
    if (ruta === "/ajustes") {
      if (usuario.role !== "owner") {
        return html(res, marco, "Ajustes", avisoSoloDuenio("los ajustes"), "ajustes");
      }
      return vistaDeAjustes(res, marco, url);
    }
    if (ruta === "/costos") return vistaDeCostos(res, marco, url);
    if (ruta.startsWith("/item/")) return vistaDeItem(res, marco, ruta.slice("/item/".length));
    if (ruta.startsWith("/borrar/")) return vistaDeBorrar(res, marco, ruta.slice("/borrar/".length));

    return enviar(
      res,
      404,
      "text/html; charset=utf-8",
      pagina({ ...marco, titulo: "No encontrado", cuerpo: `<h1>No hay nada en <code>${esc(ruta)}</code></h1>` }),
    );
  }

  // -------------------------------------------------------------------------
  // Vistas
  // -------------------------------------------------------------------------

  function vistaDeCrear(res, marco, brand) {
    const recientes = brand
      ? store
          .listItems({ brandId: brand.id, limit: 500 })
          .slice()
          .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
          .slice(0, 8)
      : [];
    const enCurso = jobsVivos()
      .map((j) => ({ ...j, angle: store.getItem(j.item_id)?.angle }))
      .filter((j) => j.angle);
    const ahora = loadConfig();
    const cuerpo =
      (modeloConfigurado(ahora) ? "" : avisoSinModelo()) +
      vistaCrear({
        cfg,
        brand,
        recientes,
        enCurso,
        hayTelegram: telegramConfigurado(ahora),
        detenidos: detenidosDe(recientes),
      });
    return html(res, marco, "Crear", cuerpo, "crear");
  }

  function vistaDeCalendario(res, marco, brand, url) {
    if (!brand) return html(res, marco, "Calendario", vistaCalendario({ cfg, brand: null }), "calendario");
    const q = leerQueryCalendario(url);
    const desde = alineadoADomingo(q.from);
    const dias = Array.from({ length: q.days }, (_, i) => addDays(desde, i));
    const hasta = dias[dias.length - 1];
    const items = store
      .listItems({ brandId: brand.id, from: desde, to: hasta, limit: 1000 })
      .filter((i) => (q.status ? i.status === q.status : true))
      .filter((i) => (q.format ? i.format === q.format : true));
    const porDia = new Map();
    for (const i of items) {
      if (!porDia.has(i.scheduled_for)) porDia.set(i.scheduled_for, []);
      porDia.get(i.scheduled_for).push(i);
    }
    return html(
      res,
      marco,
      "Calendario",
      vistaCalendario({
        cfg,
        brand,
        dias,
        itemsPorDia: porDia,
        q: { ...q, from: desde },
        hoy: today(),
        total: items.length,
        pendientes: pendientesDe(brand.id).length,
        detenidos: detenidosDe(items),
      }),
      "calendario",
    );
  }

  /**
   * Las piezas de una marca que estan esperando que alguien apriete generar.
   * Es el mismo criterio que usa generatePending, para que el numero que se
   * muestra sea el que despues se genera y no una aproximacion.
   */
  function pendientesDe(brandId) {
    const maxRegen = Number(cfg.limits?.maxRegenerationsPerItem ?? Infinity);
    return store
      .listItems({ status: ["planned", "briefed"], brandId, limit: 500 })
      .filter((it) => (it.revision ?? 0) <= maxRegen)
      .filter((it) => cfg.formats?.[it.format]?.enabled !== false);
  }

  function vistaDeConfirmarGenerar(res, marco, brand) {
    if (!brand) return html(res, marco, "Generar", avisoSinMarca(), "calendario");
    return html(
      res,
      marco,
      "Generar lo pendiente",
      vistaConfirmarGenerar({
        brand,
        piezas: pendientesDe(brand.id),
        estimacion: store.costPorFormato(),
        limite: LOTE_PENDIENTES,
        concurrencia: Math.max(1, Number(cfg.limits?.maxConcurrentGenerations ?? 1)),
      }),
      "calendario",
    );
  }

  function vistaDeConfirmarPlan(res, marco, brand, url) {
    if (!brand) return html(res, marco, "Planificar", avisoSinMarca(), "calendario");
    const dias = clamp(Number(url.searchParams.get("dias") ?? DIAS_DEFECTO) || DIAS_DEFECTO, 1, MAX_DIAS);
    const desde = today();
    const hasta = addDays(desde, dias - 1);
    return html(
      res,
      marco,
      "Planificar",
      vistaConfirmarPlan({
        brand,
        dias,
        porSemana: Number(cfg.calendar?.itemsPerWeek ?? 6),
        mezcla: Object.entries(cfg.calendar?.mix ?? {}).filter(([, n]) => Number(n) > 0),
        yaHay: store.listItems({ brandId: brand.id, from: desde, to: hasta, limit: 500 }).length,
        desde,
        hasta,
      }),
      "calendario",
    );
  }

  /**
   * Las carpetas que dejo una marca y que se pueden borrar sin miedo.
   *
   * "Sin miedo" es literal: solo entran rutas que estan DENTRO de la carpeta de
   * proyectos o de la de contenido de esta instalacion. Un project_dir apuntando
   * a cualquier otro lado (una instalacion vieja, una edicion a mano del config)
   * se ignora en vez de borrarse.
   */
  function archivosDeMarca(brand) {
    const raices = [cfg.hyperframes?.projectsDir, cfg.paths?.content].filter(Boolean).map((r) => resolve(r));
    const dentro = (p) => {
      if (!p) return false;
      const abs = resolve(p);
      return raices.some((raiz) => {
        const rel = relative(raiz, abs);
        return rel && !rel.startsWith("..") && !isAbsolute(rel);
      });
    };

    const candidatos = new Set();
    if (dentro(brand.projectDir)) candidatos.add(resolve(brand.projectDir));
    for (const it of store.listItems({ brandId: brand.id, limit: 1000 })) {
      if (dentro(it.asset_path)) candidatos.add(resolve(it.asset_path));
      for (const raiz of raices) {
        const proyecto = join(raiz, it.id);
        if (existsSync(proyecto)) candidatos.add(proyecto);
      }
    }
    return [...candidatos].filter((p) => existsSync(p));
  }

  /** Cuanto ocupa una carpeta. Aproximado y acotado: es para un cartel, no para un informe. */
  function pesoDe(rutas) {
    let total = 0;
    let vistos = 0;
    const sumar = (p) => {
      if (vistos++ > 4000) return;
      let st;
      try {
        st = statSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        let hijos = [];
        try {
          hijos = readdirSync(p);
        } catch {
          return;
        }
        for (const h of hijos) sumar(join(p, h));
      } else {
        total += st.size;
      }
    };
    for (const r of rutas) sumar(r);
    return total;
  }

  function vistaDeBorrarMarca(res, marco, id) {
    const brand = store.getBrand(id);
    if (!brand) return html(res, marco, "Marca", `<h1>No existe esa marca</h1><a class="boton" href="/marcas">Volver</a>`, "marcas");
    const archivos = archivosDeMarca(brand);
    return html(
      res,
      marco,
      `Borrar ${brand.name}`,
      vistaBorrarMarca({
        brand,
        piezas: store.listItems({ brandId: brand.id, limit: 1000 }).length,
        fuentes: store.allKnowledge(brand.id).length,
        archivos: archivos.length,
        bytes: archivos.length ? pesoDe(archivos) : 0,
      }),
      "marcas",
    );
  }

  function avisoSinMarca() {
    return `<h1>Todavia no hay ninguna marca</h1>
      <p class="sub">El contenido sale con la identidad de una marca. Crea la primera y volve.</p>
      <a class="boton primario" href="/marcas">Crear mi primera marca</a>`;
  }

  function vistaDeMarcas(res, marco, brand) {
    const creando = running.has("__marca") ? "leyendo el sitio y proponiendo la identidad" : "";
    const marcas = store.listBrands();
    return html(
      res,
      { ...marco, cabeza: marcas.slice(0, 6).map(fuentesDeMarca).join("") },
      "Marcas",
      vistaMarcas({ marcas, activa: brand?.id ?? "", creando }),
      "marcas",
    );
  }

  function vistaDeMarca(res, marco, id) {
    const brand = store.getBrand(decodeURIComponent(id));
    if (!brand) {
      return html(res, marco, "Marca", `<h1>No existe esa marca</h1><a class="boton" href="/marcas">Volver</a>`, "marcas");
    }
    return html(
      res,
      { ...marco, cabeza: fuentesDeMarca(brand) },
      brand.name,
      vistaMarca({
        brand,
        revisiones: store.brandRevisions(brand.id),
        fuentes: store.allKnowledge(brand.id),
        trabajando: running.has(`__marca:${brand.id}`) ? "aplicando el cambio y rearmando el proyecto" : "",
      }),
      "marcas",
    );
  }

  function vistaDeNueva(res, marco, brand) {
    return html(res, marco, "Agendar", vistaNueva({ cfg, brand, hoy: today() }), "calendario");
  }

  function vistaDeAjustes(res, marco, url) {
    const prueba = url.searchParams.get("prueba");
    return html(
      res,
      marco,
      "Ajustes",
      vistaAjustes({
        campos: estadoAjustes(store),
        grupos: GRUPOS,
        hayEnv: true,
        pruebas: prueba ? { ok: prueba === "ok", msg: url.searchParams.get("detalle") ?? "" } : {},
      }),
      "ajustes",
    );
  }

  /**
   * La guia de como empezar.
   *
   * No hace nada: cuenta que falta y lleva a donde se hace. Antes traia los
   * formularios adentro —la API key, la URL de la marca— y eso confundia mas de
   * lo que ayudaba: la misma cosa se hacia en dos lugares distintos y, desde
   * afuera, no quedaba claro si el asistente estaba creando la marca o
   * mostrandola. Ahora cada cosa se hace en su seccion y esto es el mapa.
   *
   * Los pasos se calculan del estado real, asi que sirve igual la primera vez
   * que un mes despues: lo que ya esta hecho se ve hecho.
   */
  function vistaDeEmpezar(res, marco, brand) {
    const ahora = loadConfig();
    const marcas = store.listBrands();
    const fuentes = brand ? store.allKnowledge(brand.id).filter((f) => f.digest) : [];
    const hechas = store.listItems({ limit: 500 }).filter((i) => i.asset_path);
    const hechos = fuentes.reduce((a, f) => a + (f.facts?.length ?? 0), 0);

    const pasos = [
      {
        titulo: "Conectá el modelo",
        detalle:
          "Brand Content AI escribe y compone con MiniMax. Su API key sale de " +
          '<a href="https://platform.minimax.io" target="_blank" rel="noopener">platform.minimax.io</a> ' +
          "&rarr; API Keys. Es lo único imprescindible: sin el modelo no se puede armar ni una marca.",
        hecho: modeloConfigurado(ahora),
        resumen: "El modelo está conectado.",
        href: "/ajustes",
        boton: "Ir a Ajustes",
      },
      {
        titulo: "Creá tu marca",
        detalle:
          "Con la URL de tu sitio saca los colores, la tipografía, el tono y de qué habla el producto. " +
          "Después la ajustás hablando: <em>más oscuro, el acento en violeta</em>.",
        hecho: marcas.length > 0,
        resumen: brand
          ? `Tu marca es <strong>${esc(brand.name)}</strong>${brand.site ? ` (${esc(brand.site)})` : ""}.`
          : `Hay ${marcas.length} marca(s) creada(s).`,
        href: "/marcas",
        boton: marcas.length ? "Ver mis marcas" : "Ir a Marcas",
      },
      {
        titulo: "Leé sus fuentes",
        detalle:
          "De acá salen los hechos que el contenido puede afirmar, cada uno con la página donde se verificó. " +
          "Sin esto las piezas salen genéricas: es lo que separa un post que dice algo de uno que suena a folleto.",
        hecho: fuentes.length > 0,
        resumen: `${fuentes.length} fuente(s) leídas, ${hechos} hechos citables.`,
        href: brand ? `/marcas/${encodeURIComponent(brand.id)}` : "/marcas",
        boton: brand ? `Abrir ${brand.name}` : "Ir a Marcas",
      },
      {
        titulo: "Pedí tu primera pieza",
        detalle:
          "Decís qué querés comunicar y elegís el formato: texto, imagen, historia vertical, carrusel, video o reel. " +
          "Sale con la identidad de tu marca y la ves armarse.",
        hecho: hechas.length > 0,
        resumen: `Ya generaste ${hechas.length} pieza(s).`,
        href: "/crear",
        boton: "Ir a Crear",
      },
    ];

    return html(res, marco, "Cómo empezar", vistaEmpezar({ pasos }), "empezar");
  }

  function vistaDeEquipo(res, marco, usuario, url) {
    return html(
      res,
      marco,
      "Equipo",
      vistaEquipo({
        usuarios: store.listUsers(),
        invitaciones: store.listInvites(),
        yo: usuario,
        base: marco.base ?? "",
        nuevoLink: url.searchParams.get("invite") ?? "",
      }),
      "equipo",
    );
  }

  function vistaDeCostos(res, marco, url) {
    const dias = clamp(Number(url.searchParams.get("dias") ?? 30) || 30, 1, 365);
    const filas = store.costSummary(dias);
    const total = filas.reduce((a, r) => a + (r.usd ?? 0), 0);
    return html(res, marco, "Costos", vistaCostos({ filas, dias, total }), "costos");
  }

  function vistaDeItem(res, marco, rawId) {
    const item = store.getItem(decodeURIComponent(rawId));
    if (!item) {
      return html(res, marco, "Pieza", `<h1>No existe esa pieza</h1><a class="boton" href="/calendario">Volver</a>`, "calendario");
    }
    const brand = item.brand_id ? store.getBrand(item.brand_id) : null;
    return html(
      res,
      marco,
      item.angle,
      vistaItem({
        item,
        brand,
        estado: estadoDe(item),
        media: bloqueMedia(item),
        cfg,
        hayTelegram: telegramConfigurado(loadConfig()),
        fallo: store.ultimoFallo(item.id),
        bitacora: store.logsDe(item.id),
      }),
      "calendario",
    );
  }

  function vistaDeBorrar(res, marco, rawId) {
    const item = store.getItem(decodeURIComponent(rawId));
    if (!item) return html(res, marco, "Borrar", `<h1>No existe esa pieza</h1>`, "calendario");
    return html(res, marco, "Borrar", vistaBorrar({ item }), "calendario");
  }

  // -------------------------------------------------------------------------
  // Acciones
  // -------------------------------------------------------------------------

  async function accion(res, nombre, params, { usuario = { role: "owner" }, base = "", marcaCookie = "", seguro = false } = {}) {
    // La marca con la que trabaja ESTA accion: la del selector, salvo que el
    // formulario nombre otra explicitamente.
    const activa = () => resolverMarca(marcaCookie);
    const soloDuenio = () =>
      usuario.role !== "owner" ? "esa acción es del dueño del panel" : null;
    const volver = (a, { msg, err } = {}) => {
      const q = msg ? `msg=${encodeURIComponent(msg)}` : err ? `err=${encodeURIComponent(err)}` : "";
      const union = q ? (a.includes("?") ? "&" : "?") : "";
      res.writeHead(303, { location: `${a}${union}${q}` });
      res.end();
    };
    const atras = () => {
      const b = params.get("back") ?? "";
      return b.startsWith("/") && !b.startsWith("//") ? b : "/crear";
    };
    const marcaDe = () => store.getBrand(params.get("brand") ?? "") ?? activa();

    switch (nombre) {
      case "ajustes": {
        const no = soloDuenio();
        if (no) return volver("/crear", { err: no });
        // Un campo vacio no toca nada (asi no hay que reescribir la API key
        // para cambiar el chat id). Un guion borra el valor.
        let tocados = 0;
        const avisos = [];
        for (const campo of CAMPOS) {
          const v = params.get(campo.clave);
          if (v === null || v === undefined) continue;
          const limpio = String(v).trim();
          if (!limpio) continue;
          if (limpio.startsWith("•")) continue; // la pista que muestra la pantalla
          try {
            const r = guardarAjuste(store, campo.clave, limpio === "-" ? "" : limpio);
            if (r.aviso) avisos.push(r.aviso);
            tocados++;
          } catch (err) {
            return volver(atras() !== "/crear" ? atras() : "/ajustes", {
              err: String(err?.message ?? err),
            });
          }
        }

        const probar = params.get("probar");
        if (probar === "modelo") {
          const r = await probarModelo();
          return volver(`/ajustes?prueba=${r.ok ? "ok" : "mal"}&detalle=${encodeURIComponent(r.detalle)}`);
        }
        if (probar === "telegram") {
          const r = await probarTelegram();
          return volver(`/ajustes?prueba=${r.ok ? "ok" : "mal"}&detalle=${encodeURIComponent(r.detalle)}`);
        }
        // Si vino del asistente, el asistente sigue: mandarlo a la pantalla de
        // ajustes completa lo saca del hilo y le muestra diez campos que no
        // tiene por que mirar todavia.
        return volver(atras() !== "/crear" ? atras() : "/ajustes", {
          msg: avisos.length
            ? avisos.join(" · ")
            : tocados
              ? `Guardado (${tocados} campo(s)).`
              : "No cambiaste nada.",
        });
      }

      // --- equipo ---
      case "invitar": {
        const no = soloDuenio();
        if (no) return volver("/equipo", { err: no });
        try {
          const inv = crearInvitacion(store, {
            email: String(params.get("email") ?? "").trim(),
            role: params.get("role") === "owner" ? "owner" : "member",
            invitedBy: usuario.id,
          });
          return volver(`/equipo?invite=${encodeURIComponent(`${base}/invitacion/${inv.token}`)}`);
        } catch (err) {
          return volver("/equipo", { err: String(err?.message ?? err) });
        }
      }

      case "invitacion-borrar": {
        const no = soloDuenio();
        if (no) return volver("/equipo", { err: no });
        store.deleteInvite(String(params.get("token") ?? ""));
        return volver("/equipo", { msg: "Invitación anulada." });
      }

      case "usuario-borrar": {
        const no = soloDuenio();
        if (no) return volver("/equipo", { err: no });
        const id = String(params.get("id") ?? "");
        if (id === usuario.id) return volver("/equipo", { err: "no te podés sacar a vos mismo" });
        if (esUltimoOwner(store, id)) {
          return volver("/equipo", { err: "es el último dueño: nombrá otro antes de sacarlo" });
        }
        store.deleteUser(id);
        return volver("/equipo", { msg: "Listo, ya no puede entrar." });
      }

      case "mi-cuenta": {
        const nombre = String(params.get("name") ?? "").trim();
        const nueva = String(params.get("password") ?? "");
        const actual = String(params.get("actual") ?? "");
        if (nombre) store.updateUser(usuario.id, { name: nombre });
        if (nueva) {
          const fila = store.getUser(usuario.id);
          if (!fila || !verifyPassword(actual, fila.pass_hash)) {
            return volver("/equipo", { err: "la contraseña actual no coincide" });
          }
          const malo = validarPassword(nueva);
          if (malo) return volver("/equipo", { err: malo });
          store.updateUser(usuario.id, { passHash: hashPassword(nueva) });
          return volver("/equipo", { msg: "Contraseña cambiada." });
        }
        return volver("/equipo", { msg: "Guardado." });
      }

      case "marca-activa": {
        const id = params.get("brand") ?? "";
        if (!store.getBrand(id)) return volver(atras(), { err: "esa marca no existe" });
        res.writeHead(303, {
          location: atras(),
          "set-cookie": galleta(seguro, "bca_marca", id, 60 * 60 * 24 * 365),
        });
        return res.end();
      }

      // El boton que sostiene la promesa del producto: pedir y que salga.
      case "crear-ahora": {
        const brand = activa();
        if (!brand) return volver("/marcas", { err: "creá una marca antes de generar contenido" });
        const tema = String(params.get("tema") ?? "").trim();
        if (!tema) return volver("/crear", { err: "decí qué querés comunicar" });
        const format = String(params.get("format") ?? "text");
        if (!cfg.formats?.[format] || cfg.formats[format].enabled === false) {
          return volver("/crear", { err: `formato invalido: ${format}` });
        }
        const puerta = puedeGenerar("__nueva");
        if (puerta) return volver("/crear", { err: puerta });

        const language = idiomaValido(brand, params.get("language"));
        const id = idLibre(`${today()}-${slugify(tema, 40) || "pieza"}`);
        store.upsertItem({
          id,
          scheduled_for: today(),
          format,
          language,
          angle: tema.slice(0, MAX_ANGLE),
          message: tema.slice(0, MAX_MESSAGE),
          status: "planned",
          brandId: brand.id,
        });
        const entregar = params.get("entregar") === "1";
        lanzar(id, () => handlers.generate?.(id, { entregar }));
        return volver(`/item/${encodeURIComponent(id)}`, { msg: "Arrancó. Esta página se actualiza sola." });
      }

      case "marca-nueva": {
        const sitio = String(params.get("url") ?? "").trim();
        const nombre = String(params.get("nombre") ?? "").trim();
        if (!sitio && !nombre) return volver("/marcas", { err: "poné al menos la URL o el nombre" });
        if (running.has("__marca")) return volver("/marcas", { err: "ya se está creando una marca" });
        if (typeof handlers.crearMarca !== "function") {
          return volver("/marcas", { err: "este panel se levantó sin el motor de marcas (usá npm run bot)" });
        }
        const colores = String(params.get("colores") ?? "")
          .split(/[\s,]+/)
          .filter((c) => /^#?[0-9a-fA-F]{3,8}$/.test(c));
        lanzar("__marca", async () => {
          const r = await handlers.crearMarca({
            url: sitio || null,
            name: nombre || null,
            colors: colores,
            hints: String(params.get("notas") ?? "").trim(),
          });
          // La marca que acabas de crear pasa a ser la activa. Terminar de
          // crearla y seguir viendo la anterior en el selector es la forma mas
          // rapida de generar contenido con la identidad equivocada.
          const nueva = r?.brand?.id;
          if (nueva) store.setDefaultBrand(nueva);
        });
        // Y se limpia la cookie para que manda la nueva por defecto.
        res.writeHead(303, {
          location: `${atras() !== "/crear" ? atras() : "/marcas"}?msg=${encodeURIComponent(
            "Creando la marca: se lee el sitio, se propone la identidad y se bajan las tipografias.",
          )}`,
          "set-cookie": galleta(seguro, "bca_marca", "", 0),
        });
        return res.end();
      }

      case "marca-revisar": {
        const brand = marcaDe();
        const feedback = String(params.get("feedback") ?? "").trim();
        if (!brand) return volver("/marcas", { err: "no existe esa marca" });
        if (!feedback) return volver(`/marcas/${brand.id}`, { err: "decí qué cambiar" });
        if (running.has(`__marca:${brand.id}`)) {
          return volver(`/marcas/${brand.id}`, { err: "ya hay un cambio en curso" });
        }
        if (typeof handlers.revisarMarca !== "function") {
          return volver(`/marcas/${brand.id}`, { err: "este panel se levantó sin el motor de marcas" });
        }
        lanzar(`__marca:${brand.id}`, () => handlers.revisarMarca(brand.id, feedback));
        return volver(`/marcas/${brand.id}`, { msg: "Aplicando el cambio…" });
      }

      case "marca-usar": {
        const brand = marcaDe();
        if (!brand) return volver("/marcas", { err: "no existe esa marca" });
        store.setDefaultBrand(brand.id);
        // El selector de marca vive en la barra de arriba, en todas las
        // pantallas: cambiar de marca tiene que dejarte donde estabas, no
        // mandarte a /marcas desde el calendario que estabas mirando.
        res.writeHead(303, {
          location: `${atras()}${atras().includes("?") ? "&" : "?"}msg=${encodeURIComponent(
            `Ahora se trabaja sobre ${brand.name}`,
          )}`,
          "set-cookie": galleta(seguro, "bca_marca", brand.id, 60 * 60 * 24 * 365),
        });
        return res.end();
      }

      case "marca-borrar": {
        const no = soloDuenio();
        if (no) return volver("/marcas", { err: no });
        const brand = marcaDe();
        if (!brand) return volver("/marcas", { err: "no existe esa marca" });

        // Los archivos se borran ANTES que la fila: despues de deleteBrand ya no
        // se puede saber que piezas eran suyas ni donde vivian.
        let borradas = 0;
        if (params.get("archivos") === "1") {
          for (const ruta of archivosDeMarca(brand)) {
            try {
              rmSync(ruta, { recursive: true, force: true });
              borradas++;
            } catch (err) {
              log?.(`  ! no se pudo borrar ${ruta}: ${err?.message ?? err}`);
            }
          }
        }

        const piezas = store.listItems({ brandId: brand.id, limit: 1000 }).length;
        store.deleteBrand(brand.id);
        const detalle = [
          piezas ? `${piezas} pieza(s) quedaron sin marca` : "",
          borradas ? `${borradas} carpeta(s) borradas del disco` : "",
        ].filter(Boolean);
        return volver("/marcas", {
          msg: `Borrada ${brand.name}${detalle.length ? `. ${detalle.join("; ")}.` : "."}`,
        });
      }

      case "tour-listo": {
        store.set(TOUR_VISTO, "1");
        return volver("/crear", { msg: "Listo. El asistente sigue en /empezar cuando lo necesites." });
      }

      case "tour-reiniciar": {
        store.del(TOUR_VISTO);
        return volver("/empezar", { msg: "" });
      }

      case "fuente-agregar": {
        const brand = marcaDe();
        const sitio = String(params.get("url") ?? "").trim();
        if (!brand) return volver("/marcas", { err: "no existe esa marca" });
        if (!sitio) return volver(`/marcas/${brand.id}`, { err: "falta la URL" });
        store.addSource({
          brandId: brand.id,
          sourceId: `${brand.id}:${slugify(sitio, 40)}`,
          kind: "url",
          ref: sitio,
          label: sitio.replace(/^https?:\/\//, "").slice(0, 40),
        });
        return volver(`/marcas/${brand.id}`, { msg: "Fuente agregada. Sincronizá para leerla." });
      }

      case "fuente-borrar": {
        const brand = marcaDe();
        store.deleteSource(String(params.get("source") ?? ""));
        return volver(`/marcas/${brand?.id ?? ""}`, { msg: "Fuente borrada." });
      }

      case "sync": {
        const brand = marcaDe();
        if (!brand) return volver("/marcas", { err: "no existe esa marca" });
        if (running.has(`__sync:${brand.id}`)) {
          return volver(`/marcas/${brand.id}`, { err: "ya se está sincronizando" });
        }
        lanzar(`__sync:${brand.id}`, () => handlers.sincronizar?.(brand.id));
        return volver(atras() !== "/crear" ? atras() : `/marcas/${brand.id}`, {
          msg: "Leyendo las fuentes…",
        });
      }

      case "plan": {
        const brand = marcaDe();
        if (!brand) return volver("/marcas", { err: "creá una marca antes de planificar" });
        if (running.has("__plan")) return volver("/calendario", { err: "ya hay una planificación en curso" });
        const dias = clamp(Number(params.get("dias") ?? 14) || 14, 1, MAX_DIAS);
        lanzar("__plan", () => handlers.plan?.(dias, undefined, brand.id));
        return volver("/calendario", { msg: `Planificando ${dias} dias…` });
      }

      case "generar-pendientes": {
        const brand = marcaDe();
        if (!brand) return volver("/marcas", { err: "creá una marca antes de generar contenido" });
        if (running.has("__pendientes")) {
          return volver("/calendario", { err: "ya hay una generación masiva en curso" });
        }
        // Solo las de esta marca: el boton vive en SU calendario, y generar de
        // paso las de otra marca es gastar plata que nadie pidio gastar.
        const cuantas = Math.min(pendientesDe(brand.id).length, LOTE_PENDIENTES);
        if (!cuantas) return volver("/calendario", { err: "no hay piezas pendientes en esta marca" });
        lanzar("__pendientes", () => handlers.generateAll?.(LOTE_PENDIENTES, brand.id));
        return volver("/calendario", {
          msg: `Generando ${cuantas} pieza${cuantas === 1 ? "" : "s"} de ${brand.name}…`,
        });
      }

      case "generar": {
        const id = params.get("id") ?? "";
        if (!store.getItem(id)) return volver("/calendario", { err: "no existe esa pieza" });
        const puerta = puedeGenerar(id);
        if (puerta) return volver(`/item/${encodeURIComponent(id)}`, { err: puerta });
        // Desde el panel se genera y se mira; enviarlo a Telegram es otro boton.
        lanzar(id, () => handlers.generate?.(id, { entregar: false }));
        return volver(`/item/${encodeURIComponent(id)}`, { msg: "Generando…" });
      }

      case "entregar": {
        const id = params.get("id") ?? "";
        try {
          await handlers.entregar?.(id);
          return volver(`/item/${encodeURIComponent(id)}`, { msg: "Enviado a Telegram." });
        } catch (err) {
          return volver(`/item/${encodeURIComponent(id)}`, { err: `no se pudo enviar: ${err?.message ?? err}` });
        }
      }

      case "aprobar": {
        const id = params.get("id") ?? "";
        if (!store.getItem(id)) return volver("/calendario", { err: "no existe esa pieza" });
        store.setStatus(id, "approved");
        return volver(`/item/${encodeURIComponent(id)}`, { msg: "Aprobada." });
      }

      case "rechazar": {
        const id = params.get("id") ?? "";
        const motivo = String(params.get("reason") ?? "").trim();
        if (!motivo) {
          return volver(`/item/${encodeURIComponent(id)}`, {
            err: "hace falta un motivo: es lo que guía la regeneración",
          });
        }
        const puerta = puedeGenerar(id);
        if (puerta) return volver(`/item/${encodeURIComponent(id)}`, { err: puerta });
        lanzar(id, () => handlers.reject?.(id, motivo));
        return volver(`/item/${encodeURIComponent(id)}`, { msg: "Regenerando con tu comentario…" });
      }

      case "crear": {
        const brand = activa();
        const datos = validarItem(params, brand);
        if (datos.error) return volver("/nuevo", { err: datos.error });
        const id = idLibre(`${datos.item.scheduled_for}-${slugify(datos.item.angle)}`);
        store.upsertItem({ ...datos.item, id, status: "planned", brandId: brand?.id ?? null });
        return volver(`/item/${encodeURIComponent(id)}`, { msg: "Agendada." });
      }

      case "editar": {
        const id = params.get("id") ?? "";
        const item = store.getItem(id);
        if (!item) return volver("/calendario", { err: "no existe esa pieza" });
        const brand = item.brand_id ? store.getBrand(item.brand_id) : activa();
        const datos = validarItem(params, brand, item);
        if (datos.error) return volver(`/item/${encodeURIComponent(id)}`, { err: datos.error });
        store.updateItem(id, datos.item);
        return volver(`/item/${encodeURIComponent(id)}`, { msg: "Guardado." });
      }

      case "borrar": {
        const id = params.get("id") ?? "";
        const item = store.getItem(id);
        if (!item) return volver("/calendario", { err: "no existe esa pieza" });
        if (estadoDe(item).kind === "running") {
          return volver(`/item/${encodeURIComponent(id)}`, { err: "se esta generando: espera a que termine" });
        }
        store.deleteItem(id);
        return volver("/calendario", { msg: `Borrada: ${item.angle}` });
      }

      case "rescatar": {
        const ids = handlers.rescue?.() ?? [];
        return volver("/calendario", {
          msg: ids.length ? `${ids.length} pieza(s) devueltas a la cola` : "No habia nada trabado",
        });
      }

      default:
        return volver("/crear", { err: `accion desconocida: ${nombre}` });
    }
  }

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  function apiEstado(res, rawId, { desde } = {}) {
    const item = store.getItem(decodeURIComponent(rawId));
    if (!item) {
      return enviar(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "no existe" }));
    }
    const estado = estadoDe(item);
    // Solo las lineas de bitacora que la pagina todavia no tiene: la pagina
    // manda el id de la ultima que vio y recibe lo que vino despues.
    const log = store.logsDe(item.id, { desde: Number(desde) || 0, limit: 200 });
    return enviar(
      res,
      200,
      "application/json; charset=utf-8",
      JSON.stringify({
        estado: item.status,
        log,
        ultimoLog: log.at(-1)?.id ?? (Number(desde) || 0),
        estadoTexto:
          item.status === "building" && estado.kind !== "running"
            ? "detenido"
            : (ETIQUETA_ESTADO[item.status] ?? item.status),
        faseTexto: faseTexto(estado.job),
        // Cuando deja de estar en curso hay cosas nuevas que mostrar (el asset,
        // el brief, el error, o el cartel de que se detuvo): ahi si conviene
        // recargar la pagina entera.
        recargar: estado.kind !== "running",
      }),
    );
  }

  /** Una llamada corta de verdad: la unica forma de saber si la key sirve. */
  async function probarModelo() {
    try {
      const { runModelo } = await import("./modelo.mjs");
      const cfgAhora = loadConfig();
      const r = await runModelo("Respond with exactly one word: OK", {
        model: cfgAhora.models?.digest ?? cfgAhora.models?.plan,
        timeoutMs: 60_000,
        retries: 0,
      });
      return { ok: true, detalle: `El modelo respondio: ${r.model ?? "?"} en ${r.ms}ms.` };
    } catch (err) {
      return { ok: false, detalle: String(err?.message ?? err).slice(0, 300) };
    }
  }

  async function probarTelegram() {
    try {
      const { sendMessage } = await import("./telegram.mjs");
      await sendMessage(loadConfig(), "Brand Content AI: prueba de conexion desde el panel.");
      return { ok: true, detalle: "Mandamos un mensaje al chat configurado." };
    } catch (err) {
      return { ok: false, detalle: String(err?.message ?? err).slice(0, 300) };
    }
  }

  function jobsVivos() {
    return store
      .activeJobs({ staleSeconds })
      .filter((j) => !j.stale && !String(j.item_id).startsWith("__"));
  }

  function estadoDe(item) {
    const job = store.activeJobs({ staleSeconds }).find((j) => j.item_id === item.id);
    if (job && !job.stale) return { kind: "running", job };
    if (running.has(item.id)) return { kind: "running", job: null };
    if (job) return { kind: "stale", job };
    if (item.status === "building") return { kind: "orphan", job: null };
    return { kind: "idle", job: null };
  }

  /**
   * Los ids que dicen "generando" pero no lo estan.
   *
   * Se calcula de una para toda una pantalla: preguntar por pieza haria una
   * consulta de jobs por cada celda del calendario.
   */
  function detenidosDe(items) {
    const jobs = store.activeJobs({ staleSeconds });
    const vivos = new Set(jobs.filter((j) => !j.stale).map((j) => j.item_id));
    const out = new Set();
    for (const it of items) {
      if (it.status !== "building") continue;
      if (vivos.has(it.id) || running.has(it.id)) continue;
      out.add(it.id);
    }
    return out;
  }

  /** El panel no es una forma de saltarse el limite que respeta el resto. */
  function puedeGenerar(id) {
    if (running.has(id)) return "Ya se está generando (lo lanzaste desde este panel).";
    if (running.has("__pendientes")) return "Hay una generación masiva en curso: esperá a que termine.";
    const job = store.activeJobs({ staleSeconds }).find((j) => j.item_id === id && !j.stale);
    if (job) return `Ya se está generando (pid ${job.pid}).`;
    const max = Math.max(1, Number(cfg.limits?.maxConcurrentGenerations ?? 2));
    const vivos = jobsVivos().length;
    if (vivos >= max) return `Ya hay ${vivos} generación(es) en curso (el límite es ${max}).`;
    return null;
  }

  /**
   * Lanza trabajo largo sin bloquear la respuesta: la pagina vuelve enseguida y
   * el avance se sigue por la base.
   */
  function lanzar(clave2, fn) {
    if (running.has(clave2)) return;
    const p = Promise.resolve()
      .then(fn)
      .catch((err) => log?.(`[web] ${clave2}: ${err?.message ?? err}`))
      .finally(() => running.delete(clave2));
    running.set(clave2, p);
  }

  // -------------------------------------------------------------------------
  // Media de una pieza
  // -------------------------------------------------------------------------

  function bloqueMedia(item) {
    const asset = item.asset_path;
    if (!asset || !existsSync(asset)) {
      // Regenerar limpia `asset_path`, asi que una pieza que ya habia salido
      // bien decia "todavia no hay entregable" teniendo su version anterior en
      // disco, a un click. Si el intento nuevo se cayo, eso es exactamente lo
      // que se quiere ver.
      const previa = store
        .listRevisions(item.id)
        .filter((r) => r.asset_path && existsSync(r.asset_path))
        .pop();
      if (previa) {
        return `<div class="card">
          <div class="entre" style="margin-bottom:12px">
            <h3 style="margin:0">Lo último que salió bien</h3>
            <span class="chip">revisión ${esc(previa.revision)}</span>
          </div>
          ${bloqueArchivo(previa.asset_path, `/asset/${encodeURIComponent(item.id)}/r${encodeURIComponent(previa.revision)}`, item.angle)}
          <p class="mini faint" style="margin-top:10px">El intento actual todavía no produjo un archivo. Este es el de la revisión anterior, que sigue en disco.</p>
        </div>`;
      }
      return `<div class="card"><p class="dim mini">Todavía no hay entregable.</p></div>`;
    }
    return `<div class="card">${bloqueArchivo(asset, `/asset/${encodeURIComponent(item.id)}`, item.angle)}</div>`;
  }

  /** Como se muestra un entregable, sea el actual o el de una revision anterior. */
  function bloqueArchivo(asset, href, alt) {
    if (statSync(asset).isDirectory()) {
      const slides = readdirSync(asset)
        .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
        .sort();
      return `<h3>${slides.length} slides</h3><div class="slides">${slides
        .map(
          (f) =>
            `<div class="preview"><img loading="lazy" src="${href}/${encodeURIComponent(f)}" alt="${esc(f)}"></div>`,
        )
        .join("")}</div>`;
    }
    const ext = extname(asset).toLowerCase();
    if (ext === ".mp4") {
      return `<div class="preview"><video controls preload="metadata" src="${href}"></video></div>`;
    }
    if (IMAGE_EXT.has(ext)) {
      return `<div class="preview"><img src="${href}" alt="${esc(alt)}"></div>`;
    }
    return `<pre class="bloque">${esc(leerTexto(asset))}</pre>`;
  }

  function servirAsset(res, resto) {
    const [rawId, ...cola] = resto.split("/");
    const item = store.getItem(decodeURIComponent(rawId));
    if (!item) return enviar(res, 404, "text/plain", "no encontrado");

    // `/asset/<id>/r3` es el entregable de la revision 3, que sigue en disco
    // aunque el intento actual haya limpiado item.asset_path.
    let raiz = item.asset_path;
    if (/^r\d+$/.test(cola[0] ?? "")) {
      const n = Number(cola.shift().slice(1));
      raiz = store.listRevisions(item.id).find((r) => Number(r.revision) === n)?.asset_path ?? null;
    }
    if (!raiz || !existsSync(raiz)) return enviar(res, 404, "text/plain", "no encontrado");
    const base = resolve(raiz);
    let destino = base;
    if (cola.length) {
      if (!statSync(base).isDirectory()) return enviar(res, 404, "text/plain", "no encontrado");
      destino = resolve(base, ...cola.map(decodeURIComponent));
      const rel = relative(base, destino);
      if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
        return enviar(res, 403, "text/plain", "prohibido");
      }
    }
    if (!existsSync(destino) || statSync(destino).isDirectory()) {
      return enviar(res, 404, "text/plain", "no encontrado");
    }
    servirArchivo(res, destino);
  }

  function servirPreview(res, rawId) {
    const item = store.getItem(decodeURIComponent(rawId));
    const p = item?.preview_path;
    if (!p || !existsSync(p) || statSync(p).isDirectory()) {
      return enviar(res, 404, "text/plain", "no encontrado");
    }
    if (!IMAGE_EXT.has(extname(p).toLowerCase())) return enviar(res, 404, "text/plain", "no encontrado");
    servirArchivo(res, resolve(p));
  }

  /**
   * El CSS con las fuentes embebidas de una marca. Va por su propia URL para
   * que el navegador lo cachee: son ~180 KB de base64 que no tienen por que
   * viajar en cada pagina.
   */
  function servirFuentes(res, id) {
    const brand = store.getBrand(id);
    const css = brand?.projectDir ? resolve(brand.projectDir, "assets", "fonts", "brand.css") : null;
    if (!css || !existsSync(css)) {
      return enviar(res, 404, "text/css; charset=utf-8", "/* esta marca no tiene fuentes propias */");
    }
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "content-length": statSync(css).size,
      "cache-control": "private, max-age=3600",
    });
    createReadStream(css).pipe(res);
  }

  function servirArchivo(res, destino) {
    res.writeHead(200, {
      "content-type": MIME[extname(destino).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(destino).size,
      "cache-control": "no-store",
    });
    createReadStream(destino).pipe(res);
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  function html(res, marco, titulo, cuerpo, tab) {
    return enviar(res, 200, "text/html; charset=utf-8", pagina({ ...marco, titulo, cuerpo, tab }));
  }

  /** La marca con la que se trabaja: la de la cookie, o la por defecto. */
  function resolverMarca(idCookie) {
    return (idCookie ? store.getBrand(idCookie) : null) ?? store.defaultBrand();
  }

  function idiomaValido(brand, pedido) {
    const validos = brand?.languages?.length ? brand.languages : ["en"];
    return validos.includes(pedido) ? pedido : validos[0];
  }

  function idLibre(base) {
    const limpio = base.slice(0, 80);
    let id = limpio;
    for (let n = 2; store.getItem(id); n++) id = `${limpio}-${n}`;
    return id;
  }

  function validarItem(params, brand, actual = {}) {
    const scheduled_for = String(params.get("scheduled_for") ?? actual.scheduled_for ?? "").trim();
    if (!esIsoDate(scheduled_for)) return { error: `fecha invalida: "${scheduled_for}"` };
    const format = String(params.get("format") ?? actual.format ?? "").trim();
    if (!cfg.formats?.[format] || cfg.formats[format].enabled === false) {
      return { error: `formato invalido: "${format}"` };
    }
    const language = idiomaValido(brand, String(params.get("language") ?? actual.language ?? ""));
    const angle = String(params.get("angle") ?? actual.angle ?? "").trim();
    if (!angle) return { error: "el angulo no puede quedar vacio" };
    if (angle.length > MAX_ANGLE) return { error: `el angulo no puede pasar de ${MAX_ANGLE} caracteres` };
    const message = String(params.get("message") ?? actual.message ?? "").trim();
    if (!message) return { error: "el mensaje no puede quedar vacio" };
    if (message.length > MAX_MESSAGE) return { error: `el mensaje no puede pasar de ${MAX_MESSAGE} caracteres` };
    return { item: { scheduled_for, format, language, angle, message } };
  }

  function leerQueryCalendario(url) {
    const sp = url.searchParams;
    const from = esIsoDate(sp.get("from")) ? sp.get("from") : today();
    const days = clamp(Number(sp.get("days") ?? DIAS_DEFECTO) || DIAS_DEFECTO, 1, MAX_DIAS);
    const status = STATUSES.includes(sp.get("status")) ? sp.get("status") : "";
    const fmt = sp.get("format") ?? "";
    const format = Object.prototype.hasOwnProperty.call(cfg.formats ?? {}, fmt) ? fmt : "";
    return { from, days, status, format };
  }

  /** Alta de la primera cuenta: la duena de la instalacion. */
  async function postSetup(req, res, tema) {
    const params = new URLSearchParams(await leerCuerpo(req));
    const valores = {
      name: String(params.get("name") ?? ""),
      email: String(params.get("email") ?? ""),
    };
    try {
      if (hayCuentas(store)) throw new AuthError("ya hay una cuenta creada");
      const password = String(params.get("password") ?? "");
      if (password !== String(params.get("password2") ?? password)) {
        throw new AuthError("las dos contrasenas tienen que ser iguales", { campo: "password" });
      }
      const user = crearCuenta(store, { ...valores, password });
      log?.(`[web] cuenta creada: ${user.email} (duenio)`);
      res.writeHead(303, {
        location: "/empezar",
        "set-cookie": galleta(esHttps(req), "bca_sesion", firmarSesion(secreto, user.id), 60 * 60 * SESION_HORAS),
      });
      return res.end();
    } catch (err) {
      return enviar(
        res,
        400,
        "text/html; charset=utf-8",
        pagina({
          titulo: "Crear tu cuenta",
          cuerpo: vistaSetup({ error: String(err?.message ?? err), valores }),
          tema,
          autenticado: false,
        }),
      );
    }
  }

  async function postInvitacion(req, res, token, tema) {
    const params = new URLSearchParams(await leerCuerpo(req));
    const valores = { name: String(params.get("name") ?? ""), email: String(params.get("email") ?? "") };
    try {
      const password = String(params.get("password") ?? "");
      if (password !== String(params.get("password2") ?? password)) {
        throw new AuthError("las dos contrasenas tienen que ser iguales");
      }
      const user = aceptarInvitacion(store, token, { ...valores, password });
      log?.(`[web] se sumo al equipo: ${user.email}`);
      res.writeHead(303, {
        location: "/empezar",
        "set-cookie": galleta(esHttps(req), "bca_sesion", firmarSesion(secreto, user.id), 60 * 60 * SESION_HORAS),
      });
      return res.end();
    } catch (err) {
      const chequeo = revisarInvitacion(store, token);
      return enviar(
        res,
        400,
        "text/html; charset=utf-8",
        pagina({
          titulo: "Invitacion",
          cuerpo: vistaInvitacion({
            invite: chequeo.ok ? chequeo.invite : null,
            motivo: chequeo.ok ? null : chequeo.motivo,
            error: String(err?.message ?? err),
            valores,
          }),
          tema,
          autenticado: false,
        }),
      );
    }
  }

  async function postLogin(req, res, tema, { modoClave = false } = {}) {
    const params = new URLSearchParams(await leerCuerpo(req));

    if (!modoClave) {
      const email = String(params.get("email") ?? "");
      const user = autenticar(store, email, String(params.get("password") ?? ""));
      if (!user) {
        // Una espera corta hace inviable probar contrasenas a mano sin molestar
        // a quien simplemente se equivoco al tipear.
        await new Promise((r) => setTimeout(r, 400));
        return enviar(
          res,
          401,
          "text/html; charset=utf-8",
          pagina({
            titulo: "Entrar",
            cuerpo: vistaLogin({ error: "Email o contrasena incorrectos", email }),
            tema,
            autenticado: false,
          }),
        );
      }
      res.writeHead(303, {
        location: faltaOnboarding() ? "/empezar" : "/crear",
        "set-cookie": galleta(esHttps(req), "bca_sesion", firmarSesion(secreto, user.id), 60 * 60 * SESION_HORAS),
      });
      return res.end();
    }

    if (!igualSeguro(String(params.get("clave") ?? ""), clavePanel())) {
      // Una espera corta hace inviable probar claves a mano sin molestar a
      // quien simplemente se equivoco al tipear.
      await new Promise((r) => setTimeout(r, 400));
      return enviar(
        res,
        401,
        "text/html; charset=utf-8",
        pagina({
          titulo: "Entrar",
          cuerpo: vistaLogin({ error: "Clave incorrecta", modoClave: true }),
          tema,
          autenticado: false,
        }),
      );
    }
    res.writeHead(303, {
      location: faltaOnboarding() ? "/empezar" : "/crear",
      "set-cookie": galleta(esHttps(req), "bca_sesion", firmarSesionClave(), 60 * 60 * SESION_HORAS),
    });
    res.end();
  }

  /**
   * ¿Todavia falta algo del tour? Decide adonde cae alguien al entrar.
   *
   * Los pasos se calculan del estado real, que es lo que permite recorrer el
   * asistente de nuevo cuando queres. La contra es que volvia solo: borrabas una
   * marca de prueba y el panel te mandaba de vuelta al tour. Por eso hay un
   * "listo, ya lo vi" guardado en el kv, que gana sobre el calculo.
   */
  function faltaOnboarding() {
    if (store.get(TOUR_VISTO) === "1") return false;
    if (!modeloConfigurado(loadConfig())) return true;
    const brand = store.defaultBrand();
    if (!brand) return true;
    if (!store.allKnowledge(brand.id).some((f) => f.digest)) return true;
    return !store.listItems({ limit: 500 }).some((i) => i.asset_path);
  }

  function avisoSoloDuenio(que) {
    return `<h1>Esto lo maneja el dueño del panel</h1>
      <p class="sub">Tu cuenta es de miembro: podés crear, generar y descargar contenido, pero ${esc(que)} los toca quien administra la instalación.</p>
      <a class="boton" href="/crear">Volver a crear</a>`;
  }

  /** Sesion del modo clave unica: no hay usuario, solo "entro quien sabia la clave". */
  function firmarSesionClave() {
    const vence = Date.now() + SESION_HORAS * 3600 * 1000;
    return `${vence}.${createHmac("sha256", secreto).update(String(vence)).digest("hex")}`;
  }

  function sesionValida(valor) {
    if (!valor) return false;
    const [venceRaw, firma] = String(valor).split(".");
    const vence = Number(venceRaw);
    if (!Number.isFinite(vence) || vence < Date.now()) return false;
    const esperada = createHmac("sha256", secreto).update(String(vence)).digest("hex");
    return igualSeguro(firma ?? "", esperada);
  }

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------

  return new Promise((resolvePromise, reject) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") return reject(new Error(mensajePuertoOcupado(listenPort)));
      reject(err);
    });
    server.listen(listenPort, listenHost, () => {
      log?.(`panel en http://${listenHost}:${listenPort}${clavePanel() ? " (con clave)" : ""}`);
      resolvePromise(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Funciones sueltas
// ---------------------------------------------------------------------------

/** El origen tal como lo ve quien entro: hace falta para el link de invitacion. */
function baseUrl(req) {
  return `${esHttps(req) ? "https" : "http"}://${req.headers.host ?? "127.0.0.1"}`;
}

function enviar(res, code, type, body) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function leerCuerpo(req) {
  return new Promise((res, rej) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 1e6) {
        rej(new Error("cuerpo demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => res(b));
    req.on("error", rej);
  });
}

function leerCookies(req) {
  const out = {};
  for (const parte of String(req.headers.cookie ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

/**
 * Una cookie del panel.
 *
 * `Secure` se pone solo cuando la request llego por HTTPS, y no siempre: con el
 * flag el navegador deja de mandarla por http, y entrar por el tunel SSH —que es
 * http contra 127.0.0.1— dejaria de funcionar. Detras de un proxy con TLS la
 * request trae `x-forwarded-proto: https`, y ahi si corresponde: sin el flag, un
 * solo pedido en claro al mismo dominio le regala la sesion a quien mire la red.
 */
function galleta(seguro, nombre, valor, maxAge) {
  const flag = seguro ? "; Secure" : "";
  return `${nombre}=${encodeURIComponent(valor)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${flag}`;
}

/** Si la request llego por TLS, sea directo o a traves del proxy de adelante. */
function esHttps(req) {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

/**
 * Un formulario alojado en otra pagina puede POSTear a tu panel sin que lo
 * veas. Si el navegador declara de donde viene y no es este panel, no corre.
 * curl no manda Origin, asi que la automatizacion local sigue andando.
 */
function mismoOrigen(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function igualSeguro(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function leerTexto(p) {
  try {
    return readFileSync(p, "utf8").slice(0, 20000);
  } catch {
    return "(no se pudo leer el archivo)";
  }
}

function esIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""))) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** El calendario arranca en domingo, como la grilla de encabezados. */
function alineadoADomingo(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return addDays(iso, -new Date(y, m - 1, d).getDay());
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
}

/**
 * El mensaje del puerto ocupado tiene que poder pegarse tal cual: `taskkill
 * /PID <pid> /F` no parsea en PowerShell y encima obliga a buscar el pid.
 */
function mensajePuertoOcupado(port) {
  const duenio = duenioDelPuerto(port);
  const alt = port + 1;
  const cmd = process.argv[2] === "web" ? "web" : "bot";
  if (duenio) {
    const quien = duenio.name ? `${duenio.pid} (${duenio.name})` : String(duenio.pid);
    const matar = process.platform === "win32" ? `taskkill /PID ${duenio.pid} /F` : `kill ${duenio.pid}`;
    const mio = !duenio.name || /^node/i.test(duenio.name);
    return [
      `el puerto ${port} ya esta ocupado — lo tiene el PID ${quien}` +
        (mio ? ", probablemente una instancia anterior." : "; fijate que sea tuyo antes de matarlo."),
      `  cerrarlo:        ${matar}`,
      `  o usar otro:     npm run ${cmd} -- --port ${alt}`,
    ].join("\n");
  }
  const mirar =
    process.platform === "win32"
      ? `netstat -ano | findstr :${port}   (el pid es la ultima columna)`
      : `lsof -i :${port}`;
  return [
    `el puerto ${port} ya esta ocupado — probablemente una instancia anterior sigue vivo.`,
    `  ver quien lo tiene:  ${mirar}`,
    `  o usar otro puerto:  npm run ${cmd} -- --port ${alt}`,
  ].join("\n");
}

function duenioDelPuerto(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      });
      for (const linea of out.split(/\r?\n/)) {
        const f = linea.trim().split(/\s+/);
        if (f.length < 5 || f[3] !== "LISTENING") continue;
        if (!f[1].endsWith(`:${port}`)) continue;
        const pid = Number(f[4]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        return { pid, name: nombreDeProceso(pid) };
      }
      return null;
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 4000,
    });
    const pid = Number(out.split(/\s+/).filter(Boolean)[0]);
    return Number.isInteger(pid) && pid > 0 ? { pid, name: null } : null;
  } catch {
    return null;
  }
}

function nombreDeProceso(pid) {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return out.match(/^"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}
