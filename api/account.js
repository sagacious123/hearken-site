// /api/account: the church's account on the website.
//
//   GET                                                → the account (signed in with the cookie) or 401
//   POST { action: "login", email, password }
//   POST { action: "signup", church, email, password } → { verify: true, email }: a code is emailed
//   POST { action: "verifySignup", email, code }       → creates the account and signs in
//   POST { action: "logout" }
//   POST { action: "sendConfirm" }                     emails a code to confirm an older account's email
//   POST { action: "confirmEmail", code }
//   POST { action: "remove", id }                      signs a computer out
//   POST { action: "church", church }                  renames the church
//   POST { action: "password", current, password }
//
// One function for all of it: the hosting plan counts functions. The website keeps its own
// sign-in in an HttpOnly cookie, apart from the app's sessions, and changing things here needs
// a request from this site (the Origin check), so other sites can't act for a signed-in owner.
import {
  accountSummary as summary, allowed, beginSignUp, body, checkCode, checkPassword, clientIp, computerId, fail, finishSignUp,
  forgetComputer, getComputers, getUser, hashPassword, normalEmail, saveComputers, saveUser, sendCode, sha256, validPassword,
} from "../lib/auth.js";
import { kv } from "../lib/kv.js";
import { now } from "../lib/pass.js";
import { ACCOUNT, HINT, readCookie, sameSite, setCookie, setHint, signedIn as webSignedIn, startSignIn } from "../lib/web.js";

const signedIn = (req, store) => webSignedIn(req, store, ACCOUNT.name, ACCOUNT.prefix);
const startWeb = (res, store, user) => startSignIn(res, store, user, ACCOUNT);

export default async function handler(req, res, store = kv) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const me = await signedIn(req, store);
      if (me) {
        // Signed in before the menu's hint existed (or it was cleared): set it again.
        if (!readCookie(req, HINT)) setHint(res, true, ACCOUNT.seconds);
        return res.status(200).json(await summary(store, me.user));
      }
      // Signed out (or the sign-in ended): the menu should say "Sign in" again.
      if (readCookie(req, HINT)) setHint(res, false);
      return fail(res, 401, "Signed out");
    }
    if (req.method !== "POST") return fail(res, 405, "GET or POST only");
    if (!sameSite(req)) return fail(res, 403, "bad request");
    const b = body(req);

    if (b.action === "login") {
      const email = normalEmail(b.email);
      if (!email || typeof b.password !== "string") return fail(res, 400, "Enter your email and password.");
      const limited = !(await allowed(store, `login:${email}`, 10, 900)) || !(await allowed(store, `login-ip:${clientIp(req)}`, 50, 900));
      if (limited) return fail(res, 429, "Too many attempts. Wait 15 minutes, or reset your password.");
      const user = await getUser(store, email);
      if (!user || !(await checkPassword(b.password, user.password))) return fail(res, 401, "Wrong email or password.");
      await startWeb(res, store, user);
      return res.status(200).json(await summary(store, user));
    }

    if (b.action === "signup") {
      const started = await beginSignUp(store, clientIp(req), b);
      if (started.error) return fail(res, started.status, started.error);
      return res.status(200).json({ verify: true, email: started.email });
    }

    if (b.action === "verifySignup") {
      const done = await finishSignUp(store, b.email, b.code);
      if (done.error) return fail(res, done.status, done.error);
      await startWeb(res, store, done.user);
      return res.status(200).json(await summary(store, done.user));
    }

    const me = await signedIn(req, store);
    if (b.action === "logout") {
      if (me) await store(["DEL", `web:${sha256(me.token)}`]);
      setCookie(res, ACCOUNT.name, "", 0);
      setHint(res, false);
      return res.status(200).json({ ok: true });
    }
    if (!me) return fail(res, 401, "Your sign-in has ended. Sign in again.");
    const { user } = me;

    if (b.action === "sendConfirm") {
      if (user.verified) return res.status(200).json(await summary(store, user));
      if (!(await allowed(store, `confirm-code:${user.email}`, 5, 3600))) return fail(res, 429, "Too many codes. Check your spam folder, or try again in an hour.");
      await sendCode(store, `confirm:${user.email}`, user.email, "verify", 30);
      return res.status(200).json({ sent: true });
    }

    if (b.action === "confirmEmail") {
      const checked = await checkCode(store, `confirm:${user.email}`, b.code, 30);
      if (checked.error) return fail(res, 400, checked.error);
      user.verified = now();
      await saveUser(store, user);
      return res.status(200).json(await summary(store, user));
    }

    if (b.action === "remove") {
      const list = await getComputers(store, user);
      const machine = Object.keys(list).find((m) => computerId(m) === b.id);
      if (machine) {
        await forgetComputer(store, list, machine);
        await saveComputers(store, user, list);
      }
      return res.status(200).json(await summary(store, user));
    }

    if (b.action === "church") {
      const church = typeof b.church === "string" ? b.church.trim() : "";
      if (!church || church.length > 120) return fail(res, 400, "Enter your church's name.");
      user.church = church;
      await saveUser(store, user);
      return res.status(200).json(await summary(store, user));
    }

    if (b.action === "password") {
      if (typeof b.current !== "string" || !(await checkPassword(b.current, user.password))) return fail(res, 400, "Your current password isn't right.");
      if (!validPassword(b.password)) return fail(res, 400, "Use a password of at least 8 characters.");
      user.password = await hashPassword(b.password);
      await saveUser(store, user);
      return res.status(200).json(await summary(store, user));
    }

    return fail(res, 400, "bad request");
  } catch (e) {
    console.error("account:", e.message);
    return fail(res, 503, "The service isn't available right now. Try again in a few minutes.");
  }
}
