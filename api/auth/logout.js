// POST /api/auth/logout { session } → { ok }
//
// Signs this computer out, freeing its place on the account.
import { body, getComputers, getUser, saveComputers, sha256 } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";

export default post(async (req, res, store) => {
  const { session } = body(req);
  if (typeof session !== "string") return res.status(200).json({ ok: true });
  const key = `session:${sha256(session)}`;
  const raw = await store(["GET", key]);
  await store(["DEL", key]);
  const s = raw ? JSON.parse(raw) : null;
  const user = s && (await getUser(store, s.email));
  if (user) {
    const list = await getComputers(store, user);
    if (list[s.machine]?.session === sha256(session)) {
      delete list[s.machine];
      await saveComputers(store, user, list);
    }
  }
  return res.status(200).json({ ok: true });
});
