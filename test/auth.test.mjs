// node --test: accounts, with an in-memory store and a throwaway signing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.LICENCE_SIGNING_KEY = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
const sent = [];
process.env.RESEND_API_KEY = "test";
process.env.EMAIL_FROM = "Hearken <test@example.com>";
globalThis.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, text: async () => "" };
};
const api = Object.fromEntries(
  await Promise.all(["signup", "login", "refresh", "logout", "forgot", "reset"].map(async (n) => [n, (await import(`../api/auth/${n}.js`)).default])),
);

const memory = () => {
  const m = new Map();
  return async ([cmd, key, ...rest]) => {
    if (cmd === "GET") return m.get(key) ?? null;
    if (cmd === "DEL") return m.delete(key) ? 1 : 0;
    if (cmd === "INCR") return m.set(key, (m.get(key) ?? 0) + 1).get(key);
    if (cmd === "EXPIRE") return 1;
    if (cmd === "SET") {
      if (rest.includes("NX") && m.has(key)) return null;
      m.set(key, rest[0]);
      return "OK";
    }
    throw new Error(cmd);
  };
};
const call = async (name, body, store) => {
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await api[name]({ method: "POST", body, headers: {} }, res, store);
  return res;
};
const payload = (pass) => JSON.parse(Buffer.from(pass.split(".")[1], "base64url"));
const machine = "b".repeat(64);
const account = { church: "Grace Chapel", email: "Media@Grace.org ", password: "hallelujah", machine };

test("sign up, sign in, renew and sign out", async () => {
  const store = memory();
  const up = await call("signup", account, store);
  assert.equal(up.code, 200);
  const p = payload(up.body.pass);
  assert.equal(p.kind, "account");
  assert.equal(p.email, "media@grace.org");
  assert.equal(p.church, "Grace Chapel");
  assert.equal(p.machine, machine);
  assert.equal(p.expires - p.issued, 30 * 86400);
  assert.equal((await call("signup", account, store)).code, 409, "one account per email");

  assert.equal((await call("login", { ...account, password: "wrong-one" }, store)).code, 401);
  const login = await call("login", { email: "media@grace.org", password: "hallelujah", machine }, store);
  assert.equal(login.code, 200);

  // A licence attached to the account comes with the renewal.
  await store(["SET", `licence:${p.user}`, "HK1.licence.key"]);
  const renewed = await call("refresh", { session: login.body.session, machine }, store);
  assert.equal(renewed.code, 200);
  assert.equal(renewed.body.licence, "HK1.licence.key");
  // The session belongs to that computer only.
  assert.equal((await call("refresh", { session: login.body.session, machine: "c".repeat(64) }, store)).code, 401);

  await call("logout", { session: login.body.session }, store);
  assert.equal((await call("refresh", { session: login.body.session, machine }, store)).code, 401);
});

test("passwords are hashed and guessing is limited", async () => {
  const store = memory();
  await call("signup", account, store);
  const saved = await store(["GET", "user:media@grace.org"]);
  assert.ok(!saved.includes("hallelujah") && saved.includes("scrypt$"));
  for (let i = 0; i < 10; i++) await call("login", { ...account, password: `guess-${i}` }, store);
  assert.equal((await call("login", account, store)).code, 429);
});

test("bad sign-ups are refused", async () => {
  const store = memory();
  assert.equal((await call("signup", { ...account, password: "short" }, store)).code, 400);
  assert.equal((await call("signup", { ...account, email: "not-an-email" }, store)).code, 400);
  assert.equal((await call("signup", { ...account, church: " " }, store)).code, 400);
});

test("a password reset works once and signs every computer out", async () => {
  const store = memory();
  const up = await call("signup", account, store);
  sent.length = 0;
  assert.equal((await call("forgot", { email: "media@grace.org" }, store)).code, 200);
  assert.equal((await call("forgot", { email: "nobody@grace.org" }, store)).code, 200, "same answer for unknown emails");
  assert.equal(sent.length, 1);
  const token = sent[0].text.match(/token=([\w-]+)/)[1];

  assert.equal((await call("reset", { token, password: "new password" }, store)).code, 200);
  assert.equal((await call("reset", { token, password: "again password" }, store)).code, 400, "links work once");
  assert.equal((await call("login", account, store)).code, 401);
  assert.equal((await call("login", { ...account, password: "new password" }, store)).code, 200);
  assert.equal((await call("refresh", { session: up.body.session, machine }, store)).code, 401, "old sessions end");
});

test("storage trouble is a 503, not a crash", async () => {
  const res = await call("login", account, async () => { throw new Error("down"); });
  assert.equal(res.code, 503);
});
