// POST /api/auth/refresh { session, machine, name? } → { pass, licence }
//
// Renews the app's offline sign-in pass and fetches the account's licence. A session ends when
// the password is reset, when it's signed out (here or from the account page), or after 400
// days unused.
import { body, computerName, fail, getComputers, getUser, passes, saveComputers, sha256 } from "../../lib/auth.js";
import { now } from "../../lib/pass.js";
import { post } from "../../lib/handler.js";
import { isHex } from "../../lib/pass.js";

export default post(async (req, res, store) => {
  const { session, machine, name } = body(req);
  if (typeof session !== "string" || !isHex(machine, 64, 64)) return fail(res, 400, "bad request");
  const raw = await store(["GET", `session:${sha256(session)}`]);
  const s = raw ? JSON.parse(raw) : null;
  const user = s && (await getUser(store, s.email));
  if (!s || !user || s.machine !== machine || (user.version ?? 0) !== s.version) {
    return fail(res, 401, "This computer was signed out of the church's account. Sign in again.");
  }
  // Remember when each computer was last used. One signed in before computers were listed is
  // added now rather than turned away.
  const list = await getComputers(store, user);
  const c = (list[machine] ??= { name: "", first: s.created ?? now(), session: sha256(session) });
  c.last = now();
  c.name = computerName(name) || c.name;
  await saveComputers(store, user, list);
  return res.status(200).json(await passes(store, user, machine));
});
