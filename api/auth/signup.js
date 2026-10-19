// POST /api/auth/signup: creating the church's account from the app, in two steps.
//
//   { church, email, password, verify: true }      → { verify: true, email }  (a code is emailed)
//   { email, code, machine, name? }                 → { session, pass, licence }
//
// Copies of the app from before email confirmation (0.3.0 and earlier) send neither `verify`
// nor `code`; their accounts are created at once, unconfirmed, and can confirm on the account
// page later.
import { randomUUID } from "node:crypto";
import { beginSignUp, body, clientIp, fail, finishSignUp, hashPassword, signUpFields, allowed, startSession } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";
import { isHex, now } from "../../lib/pass.js";

export default post(async (req, res, store) => {
  const b = body(req);
  const { machine, name } = b;

  if (b.code !== undefined) {
    if (!isHex(machine, 64, 64)) return fail(res, 400, "bad request");
    const done = await finishSignUp(store, b.email, b.code);
    if (done.error) return fail(res, done.status, done.error);
    return res.status(200).json(await startSession(store, done.user, machine, { name }));
  }

  if (b.verify) {
    const started = await beginSignUp(store, clientIp(req), b);
    if (started.error) return fail(res, started.status, started.error);
    return res.status(200).json({ verify: true, email: started.email });
  }

  // Older copies of the app.
  const f = signUpFields(b);
  if (f.error) return fail(res, 400, f.error);
  if (!isHex(machine, 64, 64)) return fail(res, 400, "bad request");
  if (!(await allowed(store, `signup:${clientIp(req)}`, 10, 3600))) return fail(res, 429, "Too many new accounts from here. Try again in an hour.");
  const user = { id: randomUUID(), email: f.email, church: f.church, password: await hashPassword(f.password), created: now(), version: 0, verified: null };
  if ((await store(["SET", `user:${f.email}`, JSON.stringify(user), "NX"])) !== "OK") {
    return fail(res, 409, "There's already an account with that email. Sign in instead.");
  }
  return res.status(200).json(await startSession(store, user, machine, { name }));
});
