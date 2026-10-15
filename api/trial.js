// POST /api/trial { machine, firstSeen, nonce, version } → { pass }
//
// Registers a computer's free trial the first time it's online, and signs its dates. The
// machine is an anonymous hash made by the app. A reinstall on the same computer gets the
// dates first registered, so the trial can't be restarted by reinstalling.
import { kv } from "../lib/kv.js";
import { DAY, TRIAL_DAYS, isHex, makePass, now, signingKey } from "../lib/pass.js";

export default async function handler(req, res, store = kv) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { machine, firstSeen, nonce, version } = req.body ?? {};
  if (!isHex(machine, 64, 64) || !isHex(nonce, 16, 64)) return res.status(400).json({ error: "bad request" });

  const t = now();
  // A copy that started offline says when: never later than now, nor earlier than a whole trial ago.
  const claimed = Number.isInteger(firstSeen) ? Math.min(t, Math.max(firstSeen, t - TRIAL_DAYS * DAY)) : t;
  const key = `trial:${machine}`;
  try {
    await store(["SET", key, JSON.stringify({ starts: claimed, registered: t, version: String(version ?? "").slice(0, 20) }), "NX"]);
    const saved = JSON.parse(await store(["GET", key]));
    // An earlier start reported later (another offline copy) moves the start earlier, never later.
    if (claimed < saved.starts) {
      saved.starts = claimed;
      await store(["SET", key, JSON.stringify(saved)]);
    }
    const pass = makePass({ kind: "trial", machine, starts: saved.starts, expires: saved.starts + TRIAL_DAYS * DAY, issued: t, nonce }, signingKey());
    return res.status(200).json({ pass });
  } catch (e) {
    console.error("trial:", e.message);
    // The app keeps its offline trial and tries again another time.
    return res.status(503).json({ error: "unavailable" });
  }
}
