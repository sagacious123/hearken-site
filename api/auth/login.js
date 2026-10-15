// POST /api/auth/login { email, password, machine } → { session, pass, licence }
import { allowed, body, checkPassword, clientIp, fail, getUser, normalEmail, startSession } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";
import { isHex } from "../../lib/pass.js";

export default post(async (req, res, store) => {
  const { password, machine } = body(req);
  const email = normalEmail(body(req).email);
  if (!email || typeof password !== "string" || !isHex(machine, 64, 64)) return fail(res, 400, "Enter your email and password.");
  const limited = !(await allowed(store, `login:${email}`, 10, 900)) || !(await allowed(store, `login-ip:${clientIp(req)}`, 50, 900));
  if (limited) return fail(res, 429, "Too many attempts. Wait 15 minutes, or reset your password.");

  const user = await getUser(store, email);
  if (!user || !(await checkPassword(password, user.password))) return fail(res, 401, "Wrong email or password.");
  return res.status(200).json(await startSession(store, user, machine));
});
