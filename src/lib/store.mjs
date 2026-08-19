// Persistencia de Brand Content AI. SQLite nativo de Node (>=22.5) — sin dependencias.
//
// El estado vive aqui y NO en memoria, porque el bot, el scheduler y la CLI
// son procesos distintos que tienen que ver lo mismo.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Una marca. Todo lo que el sistema genera pertenece a una.
--
-- El sistema nacio con UNA marca escrita en brand-content-ai.config.json. Aca la marca
-- pasa a ser un dato: se crea desde una URL o desde unos colores, se itera
-- hasta que gusta, y conviven varias en la misma instancia.
CREATE TABLE IF NOT EXISTS brands (
  id            TEXT PRIMARY KEY,           -- slug: mi-marca, acme-cloud
  name          TEXT NOT NULL,
  site          TEXT,
  audience      TEXT,                       -- a quien le habla
  voice         TEXT,                       -- como suena
  name_usage    TEXT,                       -- cRaSiNg del nombre y trampas comunes
  never         TEXT,                       -- JSON: frases prohibidas
  languages     TEXT,                       -- JSON: ["es","en"]
  language_mix  TEXT,                       -- JSON: { es: 3, en: 2 }
  palette       TEXT,                       -- JSON: { bg, surface, ink, muted, accent, line }
  fonts         TEXT,                       -- JSON: { display: {...}, mono: {...} }
  frame_md      TEXT,                       -- el sistema de diseno completo (lo lee el modelo)
  project_dir   TEXT,                       -- proyecto HyperFrames base materializado
  source_url    TEXT,                       -- de que sitio se saco
  notes         TEXT,                       -- lo que pidio el usuario al crearla
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | ready
  revision      INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cada vuelta de "no me gusta, cambiale esto" queda guardada: se puede comparar
-- y volver a una anterior sin regenerar nada.
CREATE TABLE IF NOT EXISTS brand_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id   TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL,
  frame_md   TEXT,
  palette    TEXT,
  fonts      TEXT,
  feedback   TEXT,                          -- el pedido que ORIGINO esta revision
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand_id, revision)
);

-- Una pieza de contenido a lo largo de toda su vida.
CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,           -- slug estable: 2026-08-20-agent-builds-schema
  scheduled_for  TEXT NOT NULL,              -- ISO date (YYYY-MM-DD)
  format         TEXT NOT NULL,              -- video | carousel | image | text
  language       TEXT NOT NULL DEFAULT 'en',
  angle          TEXT NOT NULL,              -- de que va: el gancho en una linea
  message        TEXT NOT NULL,              -- LA cosa que tiene que comunicar
  status         TEXT NOT NULL DEFAULT 'planned',
                 -- planned -> briefed -> building -> built -> delivered -> approved | rejected
  brief          TEXT,                       -- JSON: el brief completo que genero Claude
  asset_path     TEXT,                       -- ruta al entregable final
  preview_path   TEXT,                       -- ruta a la imagen de preview (para Telegram)
  error          TEXT,                       -- ultimo error, si fallo
  revision       INTEGER NOT NULL DEFAULT 0, -- cuantas veces se regenero
  feedback       TEXT,                       -- que pidio el usuario al rechazarlo
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_sched  ON items(scheduled_for);

-- Historial: cada intento queda, para poder comparar y volver atras.
CREATE TABLE IF NOT EXISTS revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL,
  brief      TEXT,
  asset_path TEXT,
  feedback   TEXT,                           -- el feedback que ORIGINO esta revision
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, revision)
);

-- De donde saca la marca lo que dice, y el digest ya masticado de cada fuente.
--
-- Una fila = una fuente. 'kind' decide como se lee: un repo en disco (README y
-- docs), una URL (se crawlea el sitio) o texto pegado a mano. 'fingerprint'
-- es lo que permite saltarse el resync cuando nada cambio: el commit en un
-- repo, el hash del contenido en una URL.
CREATE TABLE IF NOT EXISTS knowledge (
  source_id   TEXT PRIMARY KEY,             -- <brand>:<slug>
  brand_id    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'repo', -- repo | url | text
  ref         TEXT NOT NULL,                -- path del repo, url, o el texto
  label       TEXT,
  fingerprint TEXT,                         -- commit / hash del contenido
  digest      TEXT,                         -- markdown: que es y que sabe hacer
  facts       TEXT,                         -- JSON: hechos citables
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_brand ON knowledge(brand_id);

-- Trabajos en curso, con latido.
--
-- Vivia en memoria del proceso, asi que el panel no podia ver una generacion
-- lanzada desde otra terminal: mostraba "planificado" mientras el CLI trabajaba.
-- En la base lo ve cualquiera. El latido distingue "esta corriendo" de "el
-- proceso murio y nadie lo limpio", que es la diferencia que importa mirar.
CREATE TABLE IF NOT EXISTS jobs (
  item_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,              -- generate | plan
  phase      TEXT,                       -- brief | compose | check | render | ...
  pid        INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Quien entra al panel.
--
-- El sistema nacio con una clave unica en el .env: servia para una persona.
-- Con un equipo hace falta saber quien hizo que, poder sacarle el acceso a uno
-- sin cambiarle la clave a todos, y que cada uno tenga su contrasena.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- uuid
  email       TEXT NOT NULL UNIQUE,        -- guardado en minusculas
  name        TEXT,
  pass_hash   TEXT NOT NULL,               -- scrypt: salt$hash, nunca la contrasena
  role        TEXT NOT NULL DEFAULT 'member',  -- owner | member
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_login  TEXT
);

-- Invitaciones al equipo. Sin servidor de correo: el owner genera el link y lo
-- comparte por donde quiera. El token es de un solo uso y vence.
CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  email       TEXT,                        -- opcional: para quien fue pensada
  role        TEXT NOT NULL DEFAULT 'member',
  invited_by  TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Offset del long polling de Telegram, para no reprocesar mensajes al reiniciar.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Bitacora de operaciones: que corrio, cuanto costo, si fallo.
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                  -- plan | brief | compose | render | publish
  item_id    TEXT,
  model      TEXT,
  cost_usd   REAL,
  ms         INTEGER,
  ok         INTEGER NOT NULL DEFAULT 1,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bitacora de una pieza, linea por linea: lo mismo que se ve en la consola
-- cuando se genera desde una terminal.
--
-- Existe porque el panel es la forma normal de usar esto y desde el panel no se
-- veia nada de la corrida: ni que fallo el check, ni que se reparo, ni por que
-- se detuvo. La informacion existia (salia por consola) y no llegaba. nivel
-- distingue lo bloqueante (error) de lo cosmetico (aviso), igual que en el
-- prompt que le llega al modelo.
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL,
  nivel      TEXT NOT NULL DEFAULT 'info',   -- info | aviso | error
  texto      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_item ON logs(item_id, id);
`;

const NIVELES = new Set(["info", "aviso", "error"]);

export const STATUSES = [
  "planned",
  "briefed",
  "building",
  "built",
  "delivered",
  "approved",
  "rejected",
];

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Con WAL varios procesos leen a la vez, pero escribir sigue siendo de a uno:
  // si el panel guarda un item en el instante en que el ciclo diario anota un
  // costo, el segundo recibe SQLITE_BUSY y falla en el acto. El timeout hace
  // que espere su turno —son escrituras de milisegundos— en vez de tirar. Va
  // antes de las migraciones, que tambien escriben.
  db.exec("PRAGMA busy_timeout = 5000;");
  // El orden importa: las tablas viejas se arreglan ANTES de correr el esquema
  // (que crea indices sobre columnas que la tabla vieja no tiene), y las
  // columnas nuevas se agregan despues.
  migrateLegacy(db);
  db.exec(SCHEMA);
  migrateColumns(db);
  return new Store(db);
}

function columnasDe(db, tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}

function existeTabla(db, tabla) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tabla);
}

/**
 * Reescribe las tablas que cambiaron de forma. Corre ANTES del esquema, con la
 * base todavia como estaba, y no pierde datos: lo que ya existia pasa a la
 * marca por defecto en cuanto esa marca se crea (ver `adoptOrphans`).
 */
function migrateLegacy(db) {
  if (!existeTabla(db, "knowledge")) return;
  // knowledge nacio con una fila por repo y sin marca. Ahora una fila es una
  // fuente cualquiera (repo, url o texto pegado) y pertenece a una marca.
  const k = columnasDe(db, "knowledge");
  if (k.includes("repo_id") && !k.includes("source_id")) {
    db.exec(`ALTER TABLE knowledge RENAME TO knowledge_legacy`);
    db.exec(`
      CREATE TABLE knowledge (
        source_id   TEXT PRIMARY KEY,
        brand_id    TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'repo',
        ref         TEXT NOT NULL,
        label       TEXT,
        fingerprint TEXT,
        digest      TEXT,
        facts       TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_brand ON knowledge(brand_id);
      INSERT INTO knowledge (source_id, brand_id, kind, ref, label, fingerprint, digest, facts, updated_at)
        SELECT repo_id, '', 'repo', repo_id, repo_id, head_sha, digest, facts, updated_at
        FROM knowledge_legacy;
      DROP TABLE knowledge_legacy;
    `);
  }
}

/** Columnas nuevas sobre tablas que ya tienen la forma correcta. */
function migrateColumns(db) {
  if (!columnasDe(db, "items").includes("brand_id")) {
    db.exec(`ALTER TABLE items ADD COLUMN brand_id TEXT`);
  }
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // ---- marcas ------------------------------------------------------------
  //
  // Los campos compuestos (never, languages, palette, fonts...) viajan como
  // JSON en una columna: son datos que solo lee quien ya tiene la marca en la
  // mano, y una tabla por cada uno no compraba nada.

  /**
   * Alta o merge de una marca.
   *
   * El merge se hace en JS y no con COALESCE en el SQL: con COALESCE, un
   * upsert parcial (por ejemplo guardar solo el frame.md) mandaba los defaults
   * del INSERT y pisaba el status a "draft" y la revision a 0 — una marca lista
   * volvia a borrador cada vez que se la tocaba.
   */
  upsertBrand(brand) {
    const id = String(brand.id ?? "").trim();
    if (!id) throw new Error("una marca necesita id");
    const antes = this.db.prepare(`SELECT * FROM brands WHERE id = ?`).get(id) ?? {};

    const elegir = (nuevo, viejo, porDefecto = null) =>
      nuevo === undefined || nuevo === null ? (viejo ?? porDefecto) : nuevo;
    const elegirJson = (nuevo, viejo) =>
      nuevo === undefined || nuevo === null ? (viejo ?? null) : jsonOrNull(nuevo);

    const fila = {
      id,
      name: elegir(brand.name, antes.name, id),
      site: elegir(brand.site, antes.site),
      audience: elegir(brand.audience, antes.audience),
      voice: elegir(brand.voice, antes.voice),
      name_usage: elegir(brand.nameUsage ?? brand.name_usage, antes.name_usage),
      never: elegirJson(brand.never, antes.never),
      languages: elegirJson(brand.languages, antes.languages),
      language_mix: elegirJson(brand.languageMix ?? brand.language_mix, antes.language_mix),
      palette: elegirJson(brand.palette, antes.palette),
      fonts: elegirJson(brand.fonts, antes.fonts),
      frame_md: elegir(brand.frameMd ?? brand.frame_md, antes.frame_md),
      project_dir: elegir(brand.projectDir ?? brand.project_dir, antes.project_dir),
      source_url: elegir(brand.sourceUrl ?? brand.source_url, antes.source_url),
      notes: elegir(brand.notes, antes.notes),
      status: elegir(brand.status, antes.status, "draft"),
      revision: Number(elegir(brand.revision, antes.revision, 0)),
      is_default: Number(elegir(brand.isDefault ?? brand.is_default, antes.is_default, 0)),
    };

    this.db
      .prepare(
        `INSERT INTO brands (id, name, site, audience, voice, name_usage, never, languages,
                             language_mix, palette, fonts, frame_md, project_dir, source_url,
                             notes, status, revision, is_default, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, site = excluded.site, audience = excluded.audience,
           voice = excluded.voice, name_usage = excluded.name_usage, never = excluded.never,
           languages = excluded.languages, language_mix = excluded.language_mix,
           palette = excluded.palette, fonts = excluded.fonts, frame_md = excluded.frame_md,
           project_dir = excluded.project_dir, source_url = excluded.source_url,
           notes = excluded.notes, status = excluded.status, revision = excluded.revision,
           is_default = excluded.is_default, updated_at = datetime('now')`,
      )
      .run(
        fila.id,
        fila.name,
        fila.site,
        fila.audience,
        fila.voice,
        fila.name_usage,
        fila.never,
        fila.languages,
        fila.language_mix,
        fila.palette,
        fila.fonts,
        fila.frame_md,
        fila.project_dir,
        fila.source_url,
        fila.notes,
        fila.status,
        fila.revision,
        fila.is_default,
      );
    return this.getBrand(id);
  }

  getBrand(id) {
    const row = this.db.prepare(`SELECT * FROM brands WHERE id = ?`).get(id);
    return row ? hydrateBrand(row) : null;
  }

  listBrands() {
    return this.db
      .prepare(`SELECT * FROM brands ORDER BY is_default DESC, name ASC`)
      .all()
      .map(hydrateBrand);
  }

  /** La marca con la que trabajar cuando nadie eligio otra. */
  defaultBrand() {
    const row =
      this.db.prepare(`SELECT * FROM brands WHERE is_default = 1`).get() ??
      this.db.prepare(`SELECT * FROM brands ORDER BY created_at ASC LIMIT 1`).get();
    return row ? hydrateBrand(row) : null;
  }

  setDefaultBrand(id) {
    this.db.prepare(`UPDATE brands SET is_default = 0`).run();
    this.db.prepare(`UPDATE brands SET is_default = 1, updated_at = datetime('now') WHERE id = ?`).run(id);
    return this.getBrand(id);
  }

  /**
   * Borra la marca. Sus piezas quedan huerfanas a proposito (brand_id = NULL)
   * en vez de borrarse: el contenido ya generado es trabajo, y borrarlo por
   * tocar "eliminar marca" seria una sorpresa cara.
   */
  deleteBrand(id) {
    this.db.prepare(`UPDATE items SET brand_id = NULL WHERE brand_id = ?`).run(id);
    this.db.prepare(`DELETE FROM knowledge WHERE brand_id = ?`).run(id);
    this.db.prepare(`DELETE FROM brands WHERE id = ?`).run(id);
  }

  /** Guarda el estado actual como revision y devuelve el numero nuevo. */
  saveBrandRevision(id, { feedback = null } = {}) {
    const b = this.db.prepare(`SELECT * FROM brands WHERE id = ?`).get(id);
    if (!b) throw new Error(`no existe la marca ${id}`);
    const next = Number(b.revision ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO brand_revisions (brand_id, revision, frame_md, palette, fonts, feedback)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, next, b.frame_md, b.palette, b.fonts, feedback);
    this.db
      .prepare(`UPDATE brands SET revision = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(next, id);
    return next;
  }

  brandRevisions(id) {
    return this.db
      .prepare(`SELECT * FROM brand_revisions WHERE brand_id = ? ORDER BY revision DESC`)
      .all(id);
  }

  /**
   * Todo lo que quedo sin marca (una base anterior a las marcas) pasa a `id`.
   * Corre una sola vez en la practica, pero es idempotente.
   */
  adoptOrphans(id) {
    const a = this.db.prepare(`UPDATE items SET brand_id = ? WHERE brand_id IS NULL OR brand_id = ''`).run(id);
    const b = this.db.prepare(`UPDATE knowledge SET brand_id = ? WHERE brand_id IS NULL OR brand_id = ''`).run(id);
    return { items: a.changes ?? 0, knowledge: b.changes ?? 0 };
  }

  // ---- items -------------------------------------------------------------

  upsertItem(item) {
    const stmt = this.db.prepare(`
      INSERT INTO items (id, scheduled_for, format, language, angle, message, status, brand_id)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'planned'), ?)
      ON CONFLICT(id) DO UPDATE SET
        scheduled_for = excluded.scheduled_for,
        format        = excluded.format,
        language      = excluded.language,
        angle         = excluded.angle,
        message       = excluded.message,
        brand_id      = COALESCE(excluded.brand_id, items.brand_id),
        updated_at    = datetime('now')
    `);
    stmt.run(
      item.id,
      item.scheduled_for,
      item.format,
      item.language ?? "en",
      item.angle,
      item.message,
      item.status ?? null,
      item.brand_id ?? item.brandId ?? null,
    );
    return this.getItem(item.id);
  }

  getItem(id) {
    return this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) ?? null;
  }

  listItems({ status, from, to, brandId, limit = 100 } = {}) {
    const where = [];
    const args = [];
    // Sin marca se ven todas: el doctor y las tareas de mantenimiento miran el
    // sistema entero. El panel siempre pasa la marca que estas mirando.
    if (brandId) {
      where.push(`brand_id = ?`);
      args.push(brandId);
    }
    if (status) {
      const arr = Array.isArray(status) ? status : [status];
      where.push(`status IN (${arr.map(() => "?").join(",")})`);
      args.push(...arr);
    }
    if (from) {
      where.push(`scheduled_for >= ?`);
      args.push(from);
    }
    if (to) {
      where.push(`scheduled_for <= ?`);
      args.push(to);
    }
    const sql =
      `SELECT * FROM items` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY scheduled_for ASC, id ASC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit);
  }

  setStatus(id, status, patch = {}) {
    if (!STATUSES.includes(status)) {
      throw new Error(`estado invalido: ${status}`);
    }
    const cols = ["status = ?", "updated_at = datetime('now')"];
    const args = [status];
    for (const k of ["brief", "asset_path", "preview_path", "error", "feedback"]) {
      if (k in patch) {
        cols.push(`${k} = ?`);
        args.push(patch[k] === null ? null : String(patch[k]));
      }
    }
    args.push(id);
    this.db.prepare(`UPDATE items SET ${cols.join(", ")} WHERE id = ?`).run(...args);
    return this.getItem(id);
  }

  /** Edita los campos que el usuario puede tocar a mano desde el panel. */
  updateItem(id, patch = {}) {
    const EDITABLE = ["scheduled_for", "format", "language", "angle", "message"];
    const cols = [];
    const args = [];
    for (const k of EDITABLE) {
      if (k in patch && patch[k] != null && String(patch[k]).trim() !== "") {
        cols.push(`${k} = ?`);
        args.push(String(patch[k]).trim());
      }
    }
    if (!cols.length) return this.getItem(id);
    cols.push("updated_at = datetime('now')");
    args.push(id);
    this.db.prepare(`UPDATE items SET ${cols.join(", ")} WHERE id = ?`).run(...args);
    return this.getItem(id);
  }

  /** Borra un item y su historial. El entregable en disco no se toca. */
  deleteItem(id) {
    this.db.prepare(`DELETE FROM revisions WHERE item_id = ?`).run(id);
    this.db.prepare(`DELETE FROM logs WHERE item_id = ?`).run(id);
    const info = this.db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  // Cierra la revision actual en el historial y abre la siguiente.
  // Devuelve el nuevo numero de revision.
  bumpRevision(id, feedback) {
    const item = this.getItem(id);
    if (!item) throw new Error(`item no encontrado: ${id}`);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO revisions (item_id, revision, brief, asset_path, feedback)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, item.revision, item.brief, item.asset_path, feedback ?? null);
    const next = item.revision + 1;
    this.db
      .prepare(
        `UPDATE items SET revision = ?, feedback = ?, status = 'planned',
                          asset_path = NULL, preview_path = NULL, error = NULL,
                          updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(next, feedback ?? null, id);
    return next;
  }

  listRevisions(id) {
    return this.db
      .prepare(`SELECT * FROM revisions WHERE item_id = ? ORDER BY revision ASC`)
      .all(id);
  }

  // ---- trabajos en curso --------------------------------------------------

  startJob(itemId, { kind = "generate", phase = null, pid = process.pid } = {}) {
    this.db
      .prepare(
        `INSERT INTO jobs (item_id, kind, phase, pid, started_at, heartbeat)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(item_id) DO UPDATE SET
           kind = excluded.kind, phase = excluded.phase, pid = excluded.pid,
           started_at = datetime('now'), heartbeat = datetime('now')`,
      )
      .run(itemId, kind, phase, pid);
  }

  /** Marca avance. Llamarlo al entrar en cada fase larga. */
  beat(itemId, phase) {
    this.db
      .prepare(`UPDATE jobs SET phase = COALESCE(?, phase), heartbeat = datetime('now') WHERE item_id = ?`)
      .run(phase ?? null, itemId);
  }

  endJob(itemId) {
    this.db.prepare(`DELETE FROM jobs WHERE item_id = ?`).run(itemId);
  }

  /**
   * Trabajos con su antiguedad en segundos. `stale` marca los que no dan senal
   * hace rato: el proceso murio sin poder limpiar (kill -9, corte de luz).
   */
  activeJobs({ staleSeconds = 900 } = {}) {
    return this.db
      .prepare(
        `SELECT item_id, kind, phase, pid,
                CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) AS age_s,
                CAST((julianday('now') - julianday(heartbeat))  * 86400 AS INTEGER) AS silent_s
         FROM jobs ORDER BY started_at ASC`,
      )
      .all()
      .map((j) => ({ ...j, stale: j.silent_s > staleSeconds }));
  }

  getJob(itemId) {
    return this.activeJobs().find((j) => j.item_id === itemId) ?? null;
  }

  /**
   * El ultimo paso que fallo en una pieza, para poder decir POR QUE se detuvo.
   *
   * Un trabajo que muere sin limpiar no deja nada en `items.error`: lo unico que
   * queda es la fila de `runs` que anoto el fallo antes de que el proceso se
   * fuera. Sin esto, el panel solo puede decir "detenido" y encogerse de hombros.
   */
  ultimoFallo(itemId) {
    return (
      this.db
        .prepare(
          `SELECT kind, detail, created_at,
                  CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS hace_s
           FROM runs WHERE item_id = ? AND ok = 0 ORDER BY id DESC LIMIT 1`,
        )
        .get(itemId) ?? null
    );
  }

  // ---- usuarios ----------------------------------------------------------

  createUser({ id, email, name, passHash, role = "member" }) {
    const correo = String(email ?? "").trim().toLowerCase();
    if (!correo) throw new Error("un usuario necesita email");
    this.db
      .prepare(`INSERT INTO users (id, email, name, pass_hash, role) VALUES (?, ?, ?, ?, ?)`)
      .run(id, correo, name ?? null, passHash, role);
    return this.getUser(id);
  }

  getUser(id) {
    return this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) ?? null;
  }

  getUserByEmail(email) {
    return (
      this.db
        .prepare(`SELECT * FROM users WHERE email = ?`)
        .get(String(email ?? "").trim().toLowerCase()) ?? null
    );
  }

  listUsers() {
    return this.db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all();
  }

  countUsers() {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n ?? 0;
  }

  updateUser(id, patch = {}) {
    const cols = [];
    const args = [];
    for (const [k, col] of [["name", "name"], ["passHash", "pass_hash"], ["role", "role"], ["lastLogin", "last_login"]]) {
      if (k in patch) {
        cols.push(`${col} = ?`);
        args.push(patch[k]);
      }
    }
    if (!cols.length) return this.getUser(id);
    args.push(id);
    this.db.prepare(`UPDATE users SET ${cols.join(", ")} WHERE id = ?`).run(...args);
    return this.getUser(id);
  }

  deleteUser(id) {
    this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  }

  // ---- invitaciones ------------------------------------------------------

  createInvite({ token, email = null, role = "member", invitedBy = null, expiresAt }) {
    this.db
      .prepare(
        `INSERT INTO invites (token, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(token, email ? String(email).trim().toLowerCase() : null, role, invitedBy, expiresAt);
    return this.getInvite(token);
  }

  getInvite(token) {
    return this.db.prepare(`SELECT * FROM invites WHERE token = ?`).get(token) ?? null;
  }

  listInvites() {
    return this.db
      .prepare(`SELECT * FROM invites WHERE used_at IS NULL ORDER BY created_at DESC`)
      .all();
  }

  useInvite(token, userId) {
    this.db
      .prepare(`UPDATE invites SET used_at = datetime('now'), used_by = ? WHERE token = ?`)
      .run(userId, token);
  }

  deleteInvite(token) {
    this.db.prepare(`DELETE FROM invites WHERE token = ?`).run(token);
  }

  // ---- fuentes de conocimiento -------------------------------------------
  //
  // Una fila = una fuente de una marca. Se da de alta primero (sin digest) y
  // el sync la completa: asi el panel puede listar "de donde va a sacar los
  // hechos esta marca" antes de haber leido nada.

  addSource({ brandId, sourceId, kind = "repo", ref, label = null }) {
    const id = String(sourceId ?? "").trim() || `${brandId}:${slugPart(ref)}`;
    this.db
      .prepare(
        `INSERT INTO knowledge (source_id, brand_id, kind, ref, label)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           brand_id = excluded.brand_id,
           kind     = excluded.kind,
           ref      = excluded.ref,
           label    = COALESCE(excluded.label, knowledge.label)`,
      )
      .run(id, brandId, kind, String(ref ?? ""), label);
    return this.getKnowledge(id);
  }

  putKnowledge({ sourceId, brandId, kind, ref, label, fingerprint, digest, facts }) {
    this.db
      .prepare(
        `INSERT INTO knowledge (source_id, brand_id, kind, ref, label, fingerprint, digest, facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           brand_id    = excluded.brand_id,
           kind        = COALESCE(excluded.kind, knowledge.kind),
           ref         = COALESCE(excluded.ref, knowledge.ref),
           label       = COALESCE(excluded.label, knowledge.label),
           fingerprint = excluded.fingerprint,
           digest      = excluded.digest,
           facts       = excluded.facts,
           updated_at  = datetime('now')`,
      )
      .run(
        sourceId,
        // Sin marca todavia (instalacion vieja o test suelto) la fuente queda
        // huerfana y `adoptOrphans` la adopta cuando la marca exista.
        brandId ?? "",
        kind ?? "repo",
        String(ref ?? ""),
        label ?? null,
        fingerprint ?? null,
        digest ?? null,
        facts ? JSON.stringify(facts) : null,
      );
    return this.getKnowledge(sourceId);
  }

  getKnowledge(sourceId) {
    const row = this.db.prepare(`SELECT * FROM knowledge WHERE source_id = ?`).get(sourceId);
    return row ? hydrateSource(row) : null;
  }

  /** Las fuentes de una marca. Sin marca, todas (lo usa el doctor). */
  allKnowledge(brandId = null) {
    const sql = brandId
      ? `SELECT * FROM knowledge WHERE brand_id = ? ORDER BY source_id`
      : `SELECT * FROM knowledge ORDER BY brand_id, source_id`;
    const rows = brandId ? this.db.prepare(sql).all(brandId) : this.db.prepare(sql).all();
    return rows.map(hydrateSource);
  }

  deleteSource(sourceId) {
    this.db.prepare(`DELETE FROM knowledge WHERE source_id = ?`).run(sourceId);
  }

  // ---- kv ----------------------------------------------------------------

  /** Borra una clave del kv. Un ajuste vacio vuelve a manos del .env. */
  del(k) {
    this.db.prepare(`DELETE FROM kv WHERE k = ?`).run(k);
  }

  get(k, fallback = null) {
    const row = this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k);
    return row ? row.v : fallback;
  }

  set(k, v) {
    this.db
      .prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(k, String(v));
  }

  // ---- runs --------------------------------------------------------------

  logRun({ kind, itemId = null, model = null, costUsd = null, ms = null, ok = true, detail = null }) {
    this.db
      .prepare(
        `INSERT INTO runs (kind, item_id, model, cost_usd, ms, ok, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, itemId, model, costUsd, ms, ok ? 1 : 0, detail);
  }

  // ---- bitacora por pieza ------------------------------------------------

  /** Una linea de la bitacora de una pieza. `nivel`: info | aviso | error. */
  addLog(itemId, nivel, texto) {
    this.db
      .prepare(`INSERT INTO logs (item_id, nivel, texto) VALUES (?, ?, ?)`)
      .run(itemId, NIVELES.has(nivel) ? nivel : "info", String(texto ?? "").slice(0, 2000));
  }

  /**
   * La bitacora de una pieza, en orden. `desde` devuelve solo lo posterior a
   * ese id: es lo que usa el panel para traer las lineas nuevas mientras corre.
   */
  logsDe(itemId, { desde = 0, limit = 1000 } = {}) {
    return this.db
      .prepare(
        `SELECT id, nivel, texto, created_at FROM logs
         WHERE item_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(itemId, Number(desde) || 0, Math.max(1, Number(limit) || 1000));
  }

  /**
   * Deja solo las ultimas `keep` lineas de una pieza. Una pieza que se regenera
   * varias veces acumula bitacora; lo viejo no le sirve a nadie y crece sin tope.
   */
  pruneLogs(itemId, keep = 600) {
    this.db
      .prepare(
        `DELETE FROM logs WHERE item_id = ? AND id NOT IN (
           SELECT id FROM logs WHERE item_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(itemId, itemId, Math.max(0, Number(keep) || 0));
  }

  clearLogs(itemId) {
    this.db.prepare(`DELETE FROM logs WHERE item_id = ?`).run(itemId);
  }

  costSummary(sinceDays = 30) {
    return this.db
      .prepare(
        `SELECT kind, COUNT(*) AS n, ROUND(SUM(COALESCE(cost_usd,0)), 4) AS usd
         FROM runs
         WHERE created_at >= datetime('now', ?)
         GROUP BY kind ORDER BY usd DESC`,
      )
      .all(`-${sinceDays} days`);
  }

  /**
   * Lo que costo y tardo, en promedio, generar una pieza de cada formato.
   *
   * Es para poder decirle a alguien cuanto va a gastar ANTES de apretar
   * "generar", en vez de despues en la pantalla de costos. Sale del historial
   * real de esta instalacion: un formato que nunca se genero no aparece, y la
   * pantalla dice que no hay con que estimarlo en vez de inventar un numero.
   *
   * Se agrupa por pieza y despues se promedia: sumar las llamadas y dividir por
   * la cantidad de piezas daria el costo por llamada, no por pieza.
   */
  costPorFormato() {
    const filas = this.db
      .prepare(
        `SELECT format, ROUND(AVG(usd), 6) AS usd, CAST(AVG(ms) AS INTEGER) AS ms, COUNT(*) AS piezas
         FROM (
           SELECT i.format AS format,
                  SUM(COALESCE(r.cost_usd, 0)) AS usd,
                  SUM(COALESCE(r.ms, 0)) AS ms
           FROM runs r
           JOIN items i ON i.id = r.item_id
           WHERE i.format IS NOT NULL
           GROUP BY r.item_id, i.format
         )
         GROUP BY format`,
      )
      .all();
    return Object.fromEntries(filas.map((f) => [f.format, f]));
  }
}

/** Serializa a JSON solo si hay algo; null deja el valor anterior en el UPSERT. */
function jsonOrNull(v) {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function parseJson(v, fallback) {
  if (v === null || v === undefined || v === "") return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

/** La fila cruda con los campos JSON ya abiertos y los nombres en camelCase. */
function hydrateBrand(row) {
  return {
    ...row,
    never: parseJson(row.never, []),
    languages: parseJson(row.languages, ["en"]),
    languageMix: parseJson(row.language_mix, null),
    palette: parseJson(row.palette, {}),
    fonts: parseJson(row.fonts, {}),
    nameUsage: row.name_usage ?? null,
    frameMd: row.frame_md ?? null,
    projectDir: row.project_dir ?? null,
    sourceUrl: row.source_url ?? null,
    isDefault: !!row.is_default,
  };
}

function hydrateSource(row) {
  return {
    ...row,
    facts: parseJson(row.facts, null),
    // nombres que ya usaba el resto del codigo cuando una fuente era un repo
    repo_id: row.source_id,
    head_sha: row.fingerprint,
  };
}

/** Trozo de slug estable para armar un source_id a partir de una ref. */
function slugPart(ref) {
  return String(ref ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
