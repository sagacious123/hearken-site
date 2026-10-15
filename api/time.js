// GET /api/time?nonce=… → { pass }
//
// The website's clock, signed, so the app can tell a computer with a wrong date from one whose
// clock was turned back. The nonce stops an old answer being replayed.
import { isHex, makePass, now, signingKey } from "../lib/pass.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const nonce = req.query?.nonce;
  if (!isHex(nonce, 16, 64)) return res.status(400).json({ error: "bad request" });
  try {
    return res.status(200).json({ pass: makePass({ kind: "time", issued: now(), nonce }, signingKey()) });
  } catch (e) {
    console.error("time:", e.message);
    return res.status(503).json({ error: "unavailable" });
  }
}
