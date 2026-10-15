// POST /api/auth/refresh { session, machine } → { pass, licence }
//
// Renews the app's offline sign-in pass and fetches the account's licence. A session ends when
// the password is reset, when it's signed out, or after 400 days unused.
import { body, fail, getUser, passes, sha256 } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";
import { isHex } from "../../lib/pass.js";

export default post(async (req, res, store) => {
  const { session, machine } = body(req);
  if (typeof session !== "string" || !isHex(machine, 64, 64)) return fail(res, 400, "bad request");
  const raw = await store(["GET", `session:${sha256(session)}`]);
  const s = raw ? JSON.parse(raw) : null;
  const user = s && (await getUser(store, s.email));
  if (!s || !user || s.machine !== machine || (user.version ?? 0) !== s.version) return fail(res, 401, "Your sign-in has ended. Sign in again.");
  return res.status(200).json(await passes(store, user, machine));
});
