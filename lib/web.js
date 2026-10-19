// The website's own sign-ins, kept in HttpOnly cookies apart from the app's sessions: the
// account page (hk_account) and, on top of it, the admin dashboard (hk_admin).
import { getUser, newToken, sha256 } from "./auth.js";
import { DAY, now } from "./pass.js";

export const readCookie = (req, name) =>
  String(req.headers?.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

export const setCookie = (res, name, token, seconds, sameSite = "Lax") =>
  res.setHeader("Set-Cookie", `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${Math.round(seconds)}`);

/** Changes must come from this site: other sites can't act for someone signed in here. */
export const sameSite = (req) => {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};

/**
 * The person signed in with cookie `name` (stored as `${prefix}:<hash>`), while their password
 * hasn't been reset since. Returns { user, token, session }.
 */
export async function signedIn(req, store, name, prefix) {
  const token = readCookie(req, name);
  if (!token) return null;
  const raw = await store(["GET", `${prefix}:${sha256(token)}`]);
  const session = raw ? JSON.parse(raw) : null;
  const user = session && (await getUser(store, session.email));
  return user && (user.version ?? 0) === session.version ? { user, token, session } : null;
}

/** Starts a website sign-in for `user` and sets its cookie. */
export async function startSignIn(res, store, user, { name, prefix, seconds, sameSite: policy }) {
  const token = newToken();
  await store(["SET", `${prefix}:${sha256(token)}`, JSON.stringify({ email: user.email, version: user.version ?? 0, created: now() }), "EX", Math.round(seconds)]);
  setCookie(res, name, token, seconds, policy);
}

export const ACCOUNT = { name: "hk_account", prefix: "web", seconds: 30 * DAY, sameSite: "Lax" };
