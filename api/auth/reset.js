// POST /api/auth/reset { token, password } → { ok }
//
// Sets a new password from an emailed link, and signs out every computer.
import { body, fail, getUser, hashPassword, saveUser, sha256, validPassword } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";

export default post(async (req, res, store) => {
  const { token, password } = body(req);
  if (typeof token !== "string") return fail(res, 400, "This link isn't complete. Open it again from the email.");
  if (!validPassword(password)) return fail(res, 400, "Use a password of at least 8 characters.");
  const email = await store(["GET", `reset:${sha256(token)}`]);
  const user = email && (await getUser(store, email));
  if (!user) return fail(res, 400, "This link has expired or was already used. Ask for a new one from the app or the account page.");
  await store(["DEL", `reset:${sha256(token)}`]);
  user.password = await hashPassword(password);
  user.version = (user.version ?? 0) + 1;
  await saveUser(store, user);
  await store(["DEL", `computers:${user.id}`]);
  return res.status(200).json({ ok: true });
});
