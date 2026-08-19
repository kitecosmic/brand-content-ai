// Cuentas, sesiones e invitaciones al equipo.
//
// Sin dependencias: `scrypt` para las contrasenas y HMAC para la cookie, los
// dos de node:crypto. Nada de JWT ni de tablas de sesion — el estado que
// importa es "existe el usuario", y eso se consulta en cada request, asi que
// borrar a alguien le corta el acceso al instante.
//
// Lo que este archivo NO hace, a proposito:
//   - mandar mails: no hay servidor de correo y no vamos a pedir uno para
//     invitar a tres personas. La invitacion es un link que el owner comparte.
//   - verificar el email: no sirve de nada sin correo saliente.
//   - recuperar contrasenas: si alguien la pierde, el owner le genera otra
//     invitacion. Con un equipo chico alcanza.

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESION_DIAS = 14;
const INVITE_DIAS = 7;

export const ROLES = ["owner", "member"];

export class AuthError extends Error {
  constructor(message, { campo } = {}) {
    super(message);
    this.name = "AuthError";
    this.campo = campo ?? null;
  }
}

// ---------------------------------------------------------------------------
// Contrasenas
// ---------------------------------------------------------------------------

/** `salt$hash`, con scrypt. Nunca se guarda la contrasena. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `${salt}$${hash}`;
}

export function verifyPassword(password, guardado) {
  const [salt, hash] = String(guardado ?? "").split("$");
  if (!salt || !hash) return false;
  const calculado = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  const esperado = Buffer.from(hash, "hex");
  if (calculado.length !== esperado.length) return false;
  return timingSafeEqual(calculado, esperado);
}

/**
 * Reglas minimas y explicadas. Nada de "debe contener un simbolo": una frase
 * larga es mejor contrasena que "P@ssw0rd" y esto lo usa un equipo, no un banco.
 */
export function validarPassword(password) {
  const p = String(password ?? "");
  if (p.length < 10) return "la contrasena tiene que tener al menos 10 caracteres";
  if (/^\d+$/.test(p)) return "que no sean solo numeros";
  return null;
}

export function validarEmail(email) {
  const e = String(email ?? "").trim();
  if (!e) return "falta el email";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "ese email no parece valido";
  return null;
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

/** ¿Ya hay alguien? Si no, el panel arranca en la pantalla de crear cuenta. */
export function hayCuentas(store) {
  return store.countUsers() > 0;
}

/**
 * Crea una cuenta. La primera es siempre owner: alguien tiene que poder
 * invitar y tocar los ajustes, y en una instalacion nueva ese alguien es quien
 * la levanto.
 */
export function crearCuenta(store, { email, password, name, role }) {
  const errEmail = validarEmail(email);
  if (errEmail) throw new AuthError(errEmail, { campo: "email" });
  const errPass = validarPassword(password);
  if (errPass) throw new AuthError(errPass, { campo: "password" });
  if (store.getUserByEmail(email)) {
    throw new AuthError("ya hay una cuenta con ese email", { campo: "email" });
  }

  const primera = !hayCuentas(store);
  return store.createUser({
    id: randomUUID(),
    email,
    name: String(name ?? "").trim() || null,
    passHash: hashPassword(password),
    role: primera ? "owner" : ROLES.includes(role) ? role : "member",
  });
}

/** Devuelve el usuario si la contrasena es correcta. Nunca dice cual de los dos fallo. */
export function autenticar(store, email, password) {
  const u = store.getUserByEmail(email);
  if (!u || !verifyPassword(password, u.pass_hash)) return null;
  store.updateUser(u.id, { lastLogin: new Date().toISOString() });
  return u;
}

/**
 * Un owner no se puede borrar ni degradar si es el ultimo: dejar la instalacion
 * sin nadie que pueda invitar o tocar los ajustes la deja muerta.
 */
export function esUltimoOwner(store, userId) {
  const owners = store.listUsers().filter((u) => u.role === "owner");
  return owners.length <= 1 && owners.some((u) => u.id === userId);
}

// ---------------------------------------------------------------------------
// Sesion
// ---------------------------------------------------------------------------

/** Cookie firmada: `userId.vence.hmac`. Sin tabla de sesiones. */
export function firmarSesion(secreto, userId, { dias = SESION_DIAS } = {}) {
  const vence = Date.now() + dias * 24 * 3600 * 1000;
  const cuerpo = `${userId}.${vence}`;
  return `${cuerpo}.${hmac(secreto, cuerpo)}`;
}

/**
 * El usuario de la cookie, o null. Comprueba la firma, la expiracion y que el
 * usuario siga existiendo: borrar a alguien le corta el acceso enseguida, sin
 * necesidad de revocar nada.
 */
export function usuarioDeSesion(store, secreto, cookie) {
  const partes = String(cookie ?? "").split(".");
  if (partes.length !== 3) return null;
  const [userId, venceRaw, firma] = partes;
  const vence = Number(venceRaw);
  if (!Number.isFinite(vence) || vence < Date.now()) return null;
  if (!igual(firma, hmac(secreto, `${userId}.${vence}`))) return null;
  return store.getUser(userId);
}

// ---------------------------------------------------------------------------
// Invitaciones
// ---------------------------------------------------------------------------

export function crearInvitacion(store, { email, role = "member", invitedBy, dias = INVITE_DIAS }) {
  if (email) {
    const err = validarEmail(email);
    if (err) throw new AuthError(err, { campo: "email" });
    if (store.getUserByEmail(email)) {
      throw new AuthError("esa persona ya tiene cuenta", { campo: "email" });
    }
  }
  const token = randomBytes(24).toString("base64url");
  const expira = new Date(Date.now() + dias * 24 * 3600 * 1000).toISOString();
  return store.createInvite({
    token,
    email: email || null,
    role: ROLES.includes(role) ? role : "member",
    invitedBy: invitedBy ?? null,
    expiresAt: expira,
  });
}

/** La invitacion si sirve; si no, por que no. */
export function revisarInvitacion(store, token) {
  const inv = store.getInvite(token);
  if (!inv) return { ok: false, motivo: "esa invitacion no existe" };
  if (inv.used_at) return { ok: false, motivo: "esa invitacion ya se uso" };
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    return { ok: false, motivo: "esa invitacion vencio — pedile una nueva a quien te invito" };
  }
  return { ok: true, invite: inv };
}

/** Alta desde una invitacion: crea la cuenta y quema el token. */
export function aceptarInvitacion(store, token, { email, password, name }) {
  const chequeo = revisarInvitacion(store, token);
  if (!chequeo.ok) throw new AuthError(chequeo.motivo);
  const inv = chequeo.invite;
  // Si la invitacion era para un email concreto, ese es el que vale: si no,
  // cualquiera con el link podria entrar con otra identidad.
  const correo = inv.email || email;
  const user = crearCuenta(store, { email: correo, password, name, role: inv.role });
  store.useInvite(token, user.id);
  return user;
}

// ---------------------------------------------------------------------------

function hmac(secreto, cuerpo) {
  return createHmac("sha256", secreto).update(cuerpo).digest("hex");
}

function igual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}
