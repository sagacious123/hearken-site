// POST /api/auth/logout { session } → { ok }
import { body, sha256 } from "../../lib/auth.js";
import { post } from "../../lib/handler.js";

export default post(async (req, res, store) => {
  const { session } = body(req);
  if (typeof session === "string") await store(["DEL", `session:${sha256(session)}`]);
  return res.status(200).json({ ok: true });
});
