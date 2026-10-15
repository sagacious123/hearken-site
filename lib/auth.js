// Accounts: passwords hashed with scrypt, sessions as random tokens stored only as hashes,
// and limits on repeated attempts. Everything lives in Upstash Redis (see kv.js).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DAY, makePass, now, signingKey } from "./pass.js";

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

/** Signs the app in on one computer: a session to renew with, and a pass it checks offline. */
export async function startSession(store, user, machine) {
  const session = newToken();
  await store(["SET", `session:${sha256(session)}`, JSON.stringify({ email: user.email, machine, version: user.version ?? 0, created: now() }), "EX", SESSION_SECONDS]);
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
