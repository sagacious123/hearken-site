// node --test: the trial and time endpoints, with an in-memory store and a throwaway key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.LICENCE_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
const trial = (await import("../api/trial.js")).default;
const time = (await import("../api/time.js")).default;

const memory = () => {
  const m = new Map();
  return async ([cmd, key, value, nx]) => {
    if (cmd === "GET") return m.get(key) ?? null;
    if (nx && m.has(key)) return null;
    m.set(key, value);
    return "OK";
  };
};
const call = async (handler, req, store) => {
  const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res, store);
  return res;
};
const read = (pass) => {
  const [p, payload, sig] = pass.split(".");
  assert.equal(p, "HK1");
  assert.ok(verify(null, Buffer.from(`${p}.${payload}`), publicKey, Buffer.from(sig, "base64url")));
  return JSON.parse(Buffer.from(payload, "base64url"));
};
const machine = "a".repeat(64), nonce = "0123456789abcdef";
const now = () => Math.floor(Date.now() / 1000);

test("a computer's trial keeps its first dates", async () => {
  const store = memory();
  const first = read((await call(trial, { method: "POST", body: { machine, firstSeen: now(), nonce } }, store)).body.pass);
  assert.equal(first.kind, "trial");
  assert.equal(first.expires - first.starts, 60 * 86400);
  assert.equal(first.nonce, nonce);
  // Reinstalled weeks later: a fresh first-run date, but the registered start stands.
  const again = read((await call(trial, { method: "POST", body: { machine, firstSeen: now() + 30 * 86400, nonce } }, store)).body.pass);
  assert.equal(again.starts, first.starts);
  // An offline copy that started earlier moves it earlier, but no more than a trial's length.
  const earlier = read((await call(trial, { method: "POST", body: { machine, firstSeen: 0, nonce } }, store)).body.pass);
  assert.ok(earlier.starts < first.starts && earlier.starts >= now() - 60 * 86400 - 5);
});

test("bad requests are refused and storage trouble isn't fatal", async () => {
  assert.equal((await call(trial, { method: "GET" }, memory())).code, 405);
  assert.equal((await call(trial, { method: "POST", body: { machine: "x", nonce } }, memory())).code, 400);
  const broken = async () => { throw new Error("down"); };
  assert.equal((await call(trial, { method: "POST", body: { machine, nonce } }, broken)).code, 503);
});

test("the time is signed with the caller's nonce", async () => {
  const res = await call(time, { method: "GET", query: { nonce } });
  const t = read(res.body.pass);
  assert.equal(t.kind, "time");
  assert.equal(t.nonce, nonce);
  assert.ok(Math.abs(t.issued - now()) < 5);
  assert.equal((await call(time, { method: "GET", query: { nonce: "zz" } })).code, 400);
});
