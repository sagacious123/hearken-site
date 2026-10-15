// Wraps an endpoint: POST only, no caching, and storage trouble answered as 503.
import { kv } from "./kv.js";
import { fail } from "./auth.js";

export const post = (fn) => async (req, res, store = kv) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return fail(res, 405, "POST only");
  try {
    return await fn(req, res, store);
  } catch (e) {
    console.error(req.url, e.message);
    return fail(res, 503, "The service isn't available right now. Try again in a few minutes.");
  }
};
