// Runs the API on this computer with an in-memory store, for testing the app against it:
//   node scripts/local-api.mjs          (then HEARKEN_API=http://localhost:4400/api in the app)
// Signs with ~/.hearken/licence-signing-key.pem, like the live site.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

process.env.LICENCE_SIGNING_KEY ??= readFileSync(`${homedir()}/.hearken/licence-signing-key.pem`, "utf8");
const routes = {
  "/api/trial": "../api/trial.js",
  "/api/time": "../api/time.js",
  ...Object.fromEntries(["signup", "login", "refresh", "logout", "forgot", "reset"].map((n) => [`/api/auth/${n}`, `../api/auth/${n}.js`])),
};
const m = new Map();
const store = async ([cmd, key, ...rest]) => {
  if (cmd === "GET") return m.get(key) ?? null;
  if (cmd === "DEL") return m.delete(key) ? 1 : 0;
  if (cmd === "INCR") return m.set(key, (m.get(key) ?? 0) + 1).get(key);
  if (cmd === "EXPIRE") return 1;
  if (cmd === "SET") {
    if (rest.includes("NX") && m.has(key)) return null;
    m.set(key, rest[0]);
    return "OK";
  }
  throw new Error(`unsupported ${cmd}`);
};

const port = Number(process.env.PORT) || 4400;
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const route = routes[url.pathname];
  if (!route) return res.writeHead(404).end();
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const handler = (await import(route)).default;
  const shim = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { res.statusCode = code; return this; },
    json(body) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return this; },
  };
  await handler({ method: req.method, url: req.url, headers: req.headers, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : {} }, shim, store);
}).listen(port, () => console.log(`API on http://localhost:${port}/api`));
