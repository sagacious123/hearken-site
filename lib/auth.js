// Accounts: passwords hashed with scrypt, sessions as random tokens stored only as hashes,
// and limits on repeated attempts. Everything lives in Upstash Redis (see kv.js).
import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DAY, TRIAL_DAYS, makePass, now, signingKey } from "./pass.js";
import { sendEmail } from "./email.js";

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** How long the app may stay signed in offline before it must reach the website again. */
export const ACCOUNT_PASS_DAYS = 30;
const SESSION_SECONDS = 400 * DAY;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(password, stored) {
  const [kind, salt, key] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(got, expected);
}

export const normalEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
export const validPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200;

/** Counts attempts in a window; true while under the limit. */
export async function allowed(store, key, limit, seconds) {
  const n = await store(["INCR", `limit:${key}`]);
  if (n === 1) await store(["EXPIRE", `limit:${key}`, seconds]);
  return n <= limit;
}

export const clientIp = (req) => String(req.headers?.["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";

export async function getUser(store, email) {
  const raw = await store(["GET", `user:${email}`]);
  return raw ? JSON.parse(raw) : null;
}

export const saveUser = (store, user) => store(["SET", `user:${user.email}`, JSON.stringify(user)]);

/** How many computers one church account can be signed in on at once. */
export const COMPUTER_LIMIT = 3;

/** The id a computer goes by on the account page (never the machine hash itself). */
export const computerId = (machine) => sha256(`computer:${machine}`).slice(0, 16);
export const computerName = (name) => (typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) : "");

/** The account's signed-in computers: { [machine]: { name, first, last, session } }, session hashed. */
export async function getComputers(store, user) {
  const raw = await store(["GET", `computers:${user.id}`]);
  return raw ? JSON.parse(raw) : {};
}
export const saveComputers = (store, user, list) => store(["SET", `computers:${user.id}`, JSON.stringify(list)]);

/** For showing: most recently used first. */
export const describeComputers = (list) =>
  Object.entries(list)
    .map(([machine, c]) => ({ id: computerId(machine), name: c.name || "Unnamed computer", first: c.first, last: c.last }))
    .sort((a, b) => b.last - a.last);

/** Signs one computer out: its session ends, so its next renewal is refused. */
export async function forgetComputer(store, list, machine) {
  if (list[machine]?.session) await store(["DEL", `session:${list[machine].session}`]);
  delete list[machine];
}

/** Thrown when signing in would go over the limit; carries the computers to choose from. */
export class TooManyComputers extends Error {
  constructor(computers) {
    super(`This account is already signed in on ${COMPUTER_LIMIT} computers. Sign one of them out to use this one.`);
    this.computers = computers;
  }
}

/** Answers a TooManyComputers with the list, so the app can offer to sign one out. */
export const tooMany = (res, e) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(409).json({ error: e.message, code: "computer_limit", limit: COMPUTER_LIMIT, computers: e.computers });
};

/**
 * Signs the app in on one computer: a session to renew with, and a pass it checks offline.
 * A new computer past the limit is refused unless `replace` names one of the others to sign out.
 */
export async function startSession(store, user, machine, { name, replace } = {}) {
  const list = await getComputers(store, user);
  if (list[machine]) {
    // One sign-in per computer: signing in again ends the old one.
    await forgetComputer(store, { [machine]: list[machine] }, machine);
  } else {
    const other = replace && Object.keys(list).find((m) => computerId(m) === replace);
    if (other) await forgetComputer(store, list, other);
    if (Object.keys(list).length >= COMPUTER_LIMIT) throw new TooManyComputers(describeComputers(list));
  }
  const session = newToken();
  const t = now();
  await store(["SET", `session:${sha256(session)}`, JSON.stringify({ email: user.email, machine, version: user.version ?? 0, created: t }), "EX", SESSION_SECONDS]);
  list[machine] = { name: computerName(name) || list[machine]?.name || "", first: list[machine]?.first ?? t, last: t, session: sha256(session) };
  await saveComputers(store, user, list);
  return { session, ...(await passes(store, user, machine)) };
}

/** The signed sign-in pass, and the account's licence key if it has one. */
export async function passes(store, user, machine) {
  const t = now();
  const pass = makePass({ kind: "account", user: user.id, email: user.email, church: user.church, machine, issued: t, expires: t + ACCOUNT_PASS_DAYS * DAY }, signingKey());
  const licence = (await store(["GET", `licence:${user.id}`])) ?? null;
  return { pass, licence };
}

/** Reads a JSON body whether or not the platform already parsed it. */
export const body = (req) => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {});

export function fail(res, code, error) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(code).json({ error });
}

/** A signed key's details, without checking it (the app checks keys itself). */
export const readLicence = (key) => {
  try {
    const p = JSON.parse(Buffer.from(String(key).split(".")[1], "base64url"));
    return p.kind === "licence" ? { church: p.church, plan: p.plan, expires: p.expires, key } : null;
  } catch {
    return null;
  }
};

/** What the account page shows. */
export async function accountSummary(store, user) {
  const list = await getComputers(store, user);
  const computers = await Promise.all(
    describeComputers(list).map(async (c) => {
      const machine = Object.keys(list).find((m) => computerId(m) === c.id);
      const trial = JSON.parse((await store(["GET", `trial:${machine}`])) ?? "null");
      return { ...c, trialEnds: trial ? trial.starts + TRIAL_DAYS * DAY : null };
    }),
  );
  return {
    email: user.email,
    church: user.church,
    created: user.created,
    verified: Boolean(user.verified),
    licence: readLicence(await store(["GET", `licence:${user.id}`])),
    computers,
    limit: COMPUTER_LIMIT,
  };
}

// ---------- emailed codes ----------

/** Emails a 6-digit code to `to` and keeps its hash (with `data`) under `key` for `minutes`. */
export async function sendCode(store, key, to, purpose, minutes, data = {}) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await store(["SET", key, JSON.stringify({ ...data, code: sha256(code), tries: 0 }), "EX", minutes * 60]);
  await sendEmail({ to, template: "verification-code", data: { code, purpose, expiresInMinutes: minutes } });
}

/**
 * Checks a code against `key`: { ok, data } once (then it's gone), or { error } after a wrong
 * code (five guesses) or once it has expired.
 */
export async function checkCode(store, key, code, minutes) {
  const saved = JSON.parse((await store(["GET", key])) ?? "null");
  if (!saved || saved.tries >= 5) return { error: "That code has expired. Ask for a new one." };
  if (sha256(String(code ?? "").trim()) !== saved.code) {
    saved.tries++;
    await store(["SET", key, JSON.stringify(saved), "EX", minutes * 60]);
    return { error: saved.tries >= 5 ? "Too many wrong codes. Ask for a new one." : "That code isn’t right. Check the email and try again." };
  }
  await store(["DEL", key]);
  return { ok: true, data: saved };
}

// ---------- signing up with a confirmed email ----------

const SIGNUP_MINUTES = 30;

/** Checks a sign-up's details: an error to show, or the cleaned-up fields. */
export function signUpFields(fields) {
  const email = normalEmail(fields.email);
  const church = typeof fields.church === "string" ? fields.church.trim() : "";
  if (!church || church.length > 120) return { error: "Enter your church's name." };
  if (!validEmail(email)) return { error: "Enter a valid email address." };
  if (!validPassword(fields.password)) return { error: "Use a password of at least 8 characters." };
  return { email, church, password: fields.password };
}

/**
 * The first step of signing up: nothing is created yet. The details wait, with the password
 * already hashed, until the code emailed to the address comes back. Asking again sends a new code.
 */
export async function beginSignUp(store, ip, fields) {
  const f = signUpFields(fields);
  if (f.error) return { status: 400, error: f.error };
  if (!(await allowed(store, `signup:${ip}`, 10, 3600))) return { status: 429, error: "Too many new accounts from here. Try again in an hour." };
  if (await getUser(store, f.email)) return { status: 409, error: "There's already an account with that email. Sign in instead." };
  if (!(await allowed(store, `signup-code:${f.email}`, 5, 3600))) return { status: 429, error: "Too many codes for this email. Check your spam folder, or try again in an hour." };
  await sendCode(store, `pending:${f.email}`, f.email, "sign-up", SIGNUP_MINUTES, { church: f.church, password: await hashPassword(f.password) });
  return { email: f.email };
}

/** The second step: the right code creates the account, its email confirmed. */
export async function finishSignUp(store, email, code) {
  const address = normalEmail(email);
  const checked = await checkCode(store, `pending:${address}`, code, SIGNUP_MINUTES);
  if (checked.error) return { status: 400, error: checked.error };
  const t = now();
  const user = { id: randomUUID(), email: address, church: checked.data.church, password: checked.data.password, created: t, version: 0, verified: t };
  if ((await store(["SET", `user:${address}`, JSON.stringify(user), "NX"])) !== "OK") {
    return { status: 409, error: "There's already an account with that email. Sign in instead." };
  }
  return { user };
}
