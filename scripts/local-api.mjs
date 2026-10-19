// Runs the API on this computer with an in-memory store, for testing the app against it:
//   node scripts/local-api.mjs          (then HEARKEN_API=http://localhost:4400/api in the app)
// Signs with ~/.hearken/licence-signing-key.pem, like the live site.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

process.env.LICENCE_SIGNING_KEY ??= readFileSync(`${homedir()}/.hearken/licence-signing-key.pem`, "utf8");
// Emails aren't sent from here: they're printed, and the last one to each address can be read
// back at /api/dev/mail?to=… (for the app's tests, which need sign-up codes).
process.env.MAILER_SECRET_KEY = "local";
process.env.MAILER_URL = "http://mail.local/send";
const mail = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith("http://mail.local/")) return realFetch(url, opts);
  const message = JSON.parse(opts.body);
  mail.set(message.to, message);
  console.log(`email to ${message.to}: ${message.template} ${JSON.stringify(message.data)}`);
  return { ok: true, text: async () => "" };
};
const routes = {
  "/api/trial": "../api/trial.js",
  "/api/time": "../api/time.js",
  "/api/account": "../api/account.js",
  "/api/admin": "../api/admin.js",
  ...Object.fromEntries(["signup", "login", "refresh", "logout", "forgot", "reset"].map((n) => [`/api/auth/${n}`, `../api/auth/${n}.js`])),
};
const m = new Map();
const store = async ([cmd, key, ...rest]) => {
  if (cmd === "GET") return m.get(key) ?? null;
  if (cmd === "DEL") return m.delete(key) ? 1 : 0;
  if (cmd === "INCR") return m.set(key, (m.get(key) ?? 0) + 1).get(key);
  if (cmd === "EXPIRE") return 1;
  if (cmd === "MGET") return [key, ...rest].map((k) => m.get(k) ?? null);
  if (cmd === "SCAN") {
    const pattern = new RegExp("^" + rest[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return ["0", [...m.keys()].filter((k) => pattern.test(k))];
  }
  if (cmd === "LPUSH") return m.set(key, [rest[0], ...(m.get(key) ?? [])]).get(key).length;
  if (cmd === "LRANGE") return (m.get(key) ?? []).slice(Number(rest[0]), Number(rest[1]) + 1);
  if (cmd === "LTRIM") return m.set(key, (m.get(key) ?? []).slice(Number(rest[0]), Number(rest[1]) + 1)) && "OK";
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
  if (url.pathname === "/api/dev/mail") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(mail.get(url.searchParams.get("to")) ?? null));
  }
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
