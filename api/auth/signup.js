// POST /api/auth/signup { church, email, password, machine } → { session, pass, licence }
import { randomUUID } from "node:crypto";
import { allowed, body, clientIp, fail, getUser, hashPassword, normalEmail, saveUser, startSession, validEmail, validPassword } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";
import { isHex, now } from "../../lib/pass.js";

export default post(async (req, res, store) => {
  const { church, password, machine } = body(req);
  const email = normalEmail(body(req).email);
  const name = typeof church === "string" ? church.trim() : "";
  if (!name || name.length > 120) return fail(res, 400, "Enter your church's name.");
  if (!validEmail(email)) return fail(res, 400, "Enter a valid email address.");
  if (!validPassword(password)) return fail(res, 400, "Use a password of at least 8 characters.");
  if (!isHex(machine, 64, 64)) return fail(res, 400, "bad request");
  if (!(await allowed(store, `signup:${clientIp(req)}`, 10, 3600))) return fail(res, 429, "Too many new accounts from here. Try again in an hour.");

  const user = { id: randomUUID(), email, church: name, password: await hashPassword(password), created: now(), version: 0 };
  if ((await store(["SET", `user:${email}`, JSON.stringify(user), "NX"])) !== "OK") {
    return fail(res, 409, "There's already an account with that email. Sign in instead.");
  }
  return res.status(200).json(await startSession(store, user, machine));
});
