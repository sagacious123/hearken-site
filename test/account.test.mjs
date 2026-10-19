// node --test: the computer limit and the website's account page, with an in-memory store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.LICENCE_SIGNING_KEY = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
process.env.MAILER_SECRET_KEY = "test";
const sent = [];
globalThis.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, text: async () => "" };
};
const auth = Object.fromEntries(
  await Promise.all(["signup", "login", "refresh", "logout"].map(async (n) => [n, (await import(`../api/auth/${n}.js`)).default])),
);
const account = (await import("../api/account.js")).default;

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
const reply = () => ({ code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (name, body, store) => {
  const res = reply();
  await auth[name]({ method: "POST", body, headers: {} }, res, store);
  return res;
};
/** The account page, as a browser on the site would call it. */
const web = async (store, cookie, method, body, origin = "https://hearken.test") => {
  const res = reply();
  await account({ method, body, headers: { host: "hearken.test", origin, cookie: cookie ?? "" } }, res, store);
  return res;
};
const cookieOf = (res) => [res.headers["Set-Cookie"] ?? []].flat().find((c) => c.startsWith("hk_account="))?.split(";")[0];
/** The code in the last email sent to `to`. */
const codeFor = (to) => sent.filter((m) => m.to === to).at(-1)?.data.code;
/** Signs up on the website: details, then the emailed code. */
const webSignUp = async (store, fields) => {
  const first = await web(store, null, "POST", { action: "signup", ...fields });
  if (first.code !== 200) return first;
  return web(store, null, "POST", { action: "verifySignup", email: fields.email, code: codeFor(first.body.email) });
};
const machines = ["a", "b", "c", "d"].map((c) => c.repeat(64));
const owner = { church: "Grace Chapel", email: "media@grace.org", password: "hallelujah" };

test("an account signs in on three computers, and a fourth can replace one", async () => {
  const store = memory();
  const up = await call("signup", { ...owner, machine: machines[0], name: "Media desk" }, store);
  assert.equal(up.code, 200);
  await call("login", { ...owner, machine: machines[1], name: "Pastor's laptop" }, store);
  await call("login", { ...owner, machine: machines[2], name: "Youth hall" }, store);
  // Signing in again on a computer already counted doesn't use another place.
  assert.equal((await call("login", { ...owner, machine: machines[2] }, store)).code, 200);

  const fourth = await call("login", { ...owner, machine: machines[3], name: "Spare" }, store);
  assert.equal(fourth.code, 409);
  assert.equal(fourth.body.code, "computer_limit");
  assert.deepEqual(fourth.body.computers.map((c) => c.name).sort(), ["Media desk", "Pastor's laptop", "Youth hall"]);
  assert.ok(fourth.body.computers.every((c) => /^[0-9a-f]{16}$/.test(c.id)), "computers go by an id, not the machine hash");

  const desk = fourth.body.computers.find((c) => c.name === "Media desk");
  const replaced = await call("login", { ...owner, machine: machines[3], name: "Spare", replace: desk.id }, store);
  assert.equal(replaced.code, 200);
  assert.equal((await call("refresh", { session: up.body.session, machine: machines[0] }, store)).code, 401, "the replaced computer is signed out");
});

test("signing out frees a place, and renewals keep the last-used date", async () => {
  const store = memory();
  const sessions = [];
  sessions.push((await call("signup", { ...owner, machine: machines[0] }, store)).body.session);
  for (const m of machines.slice(1, 3)) sessions.push((await call("login", { ...owner, machine: m }, store)).body.session);
  await call("logout", { session: sessions[1] }, store);
  assert.equal((await call("login", { ...owner, machine: machines[3] }, store)).code, 200);
  assert.equal((await call("refresh", { session: sessions[0], machine: machines[0], name: "Media desk" }, store)).code, 200);
});

test("a computer signed in before the list existed is kept on renewal", async () => {
  const store = memory();
  const up = await call("signup", { ...owner, machine: machines[0] }, store);
  const user = JSON.parse(await store(["GET", "user:media@grace.org"]));
  await store(["DEL", `computers:${user.id}`]);
  assert.equal((await call("refresh", { session: up.body.session, machine: machines[0], name: "Old desk" }, store)).code, 200);
  const list = JSON.parse(await store(["GET", `computers:${user.id}`]));
  assert.equal(list[machines[0]].name, "Old desk");
});

test("the account page signs in with a cookie and manages computers", async () => {
  const store = memory();
  const app = await call("signup", { ...owner, machine: machines[0], name: "Media desk" }, store);
  await store(["SET", `trial:${machines[0]}`, JSON.stringify({ starts: 1000 })]);

  assert.equal((await web(store, null, "GET")).code, 401);
  assert.equal((await web(store, null, "POST", { action: "login", email: owner.email, password: "wrong-one" })).code, 401);
  const login = await web(store, null, "POST", { action: "login", email: "Media@Grace.org", password: owner.password });
  assert.equal(login.code, 200);
  const [session, hint] = login.headers["Set-Cookie"];
  assert.match(session, /^hk_account=.*HttpOnly; Secure; SameSite=Lax/);
  assert.match(hint, /^hk_signed_in=1; Path=\/; Secure; SameSite=Lax; Max-Age=2592000$/, "a readable hint, no HttpOnly, nothing secret");
  const cookie = cookieOf(login);

  const me = await web(store, cookie, "GET");
  assert.equal(me.body.church, "Grace Chapel");
  assert.equal(me.body.limit, 3);
  assert.equal(me.body.computers[0].name, "Media desk");
  assert.equal(me.body.computers[0].trialEnds, 1000 + 60 * 86400);
  assert.equal(me.body.licence, null);

  const renamed = await web(store, cookie, "POST", { action: "church", church: "Grace Chapel Ikeja" });
  assert.equal(renamed.body.church, "Grace Chapel Ikeja");
  const after = await call("refresh", { session: app.body.session, machine: machines[0] }, store);
  assert.equal(JSON.parse(Buffer.from(after.body.pass.split(".")[1], "base64url")).church, "Grace Chapel Ikeja", "the app gets the new name");

  const removed = await web(store, cookie, "POST", { action: "remove", id: me.body.computers[0].id });
  assert.equal(removed.body.computers.length, 0);
  assert.equal((await call("refresh", { session: app.body.session, machine: machines[0] }, store)).code, 401, "signed out from the website");

  assert.equal((await web(store, cookie, "POST", { action: "password", current: "nope", password: "new password" })).code, 400);
  assert.equal((await web(store, cookie, "POST", { action: "password", current: owner.password, password: "new password" })).code, 200);
  assert.equal((await call("login", { ...owner, password: "new password", machine: machines[1] }, store)).code, 200);

  const out = await web(store, cookie, "POST", { action: "logout" });
  assert.equal(out.code, 200);
  assert.ok(out.headers["Set-Cookie"].some((c) => c.startsWith("hk_signed_in=;") && c.includes("Max-Age=0")), "the hint goes on signing out");
  assert.equal((await web(store, cookie, "GET")).code, 401);
});

test("the account page refuses other sites, and shows a licence", async () => {
  const store = memory();
  const up = await webSignUp(store, owner);
  assert.equal(up.code, 200);
  const cookie = cookieOf(up);
  assert.equal((await web(store, cookie, "POST", { action: "church", church: "Evil" }, "https://evil.example")).code, 403);
  const user = JSON.parse(await store(["GET", "user:media@grace.org"]));
  const key = "HK1." + Buffer.from(JSON.stringify({ kind: "licence", church: "Grace Chapel", plan: "standard", expires: 2e9 })).toString("base64url") + ".sig";
  await store(["SET", `licence:${user.id}`, key]);
  const me = await web(store, cookie, "GET");
  assert.deepEqual(me.body.licence, { church: "Grace Chapel", plan: "standard", expires: 2e9, key });
  assert.equal((await web(store, null, "POST", { action: "signup", ...owner })).code, 409, "one account per email");
});

test("signing up on the website needs the emailed code", async () => {
  const store = memory();
  sent.length = 0;
  const first = await web(store, null, "POST", { action: "signup", ...owner, email: "New@Grace.org " });
  assert.deepEqual(first.body, { verify: true, email: "new@grace.org" });
  assert.equal(first.headers["Set-Cookie"], undefined, "not signed in yet");
  assert.equal(await store(["GET", "user:new@grace.org"]), null, "no account until the code comes back");
  assert.equal(sent[0].template, "verification-code");
  assert.equal(sent[0].data.purpose, "sign-up");
  const code = sent[0].data.code;
  const wrong = await web(store, null, "POST", { action: "verifySignup", email: "new@grace.org", code: code === "123456" ? "654321" : "123456" });
  assert.equal(wrong.code, 400);
  const done = await web(store, null, "POST", { action: "verifySignup", email: "new@grace.org", code });
  assert.equal(done.code, 200);
  assert.equal(done.body.verified, true);
  assert.ok(cookieOf(done));
  assert.equal((await web(store, null, "POST", { action: "verifySignup", email: "new@grace.org", code })).code, 400, "a code works once");
});

test("five wrong codes end a sign-up", async () => {
  const store = memory();
  await web(store, null, "POST", { action: "signup", ...owner });
  const code = codeFor(owner.email);
  for (let i = 0; i < 5; i++) await web(store, null, "POST", { action: "verifySignup", email: owner.email, code: String((Number(code) + 1 + i) % 1e6).padStart(6, "0") });
  assert.equal((await web(store, null, "POST", { action: "verifySignup", email: owner.email, code })).code, 400);
});

test("the app signs up in two steps; older copies still can, unconfirmed", async () => {
  const store = memory();
  const first = await call("signup", { ...owner, verify: true }, store);
  assert.deepEqual(first.body, { verify: true, email: owner.email });
  const done = await call("signup", { email: owner.email, code: codeFor(owner.email), machine: machines[0], name: "Media desk" }, store);
  assert.equal(done.code, 200);
  assert.ok(done.body.session && done.body.pass);
  assert.ok(JSON.parse(await store(["GET", `user:${owner.email}`])).verified);

  const old = await call("signup", { ...owner, email: "old@grace.org", machine: machines[1] }, store);
  assert.equal(old.code, 200, "0.3.0 sends no verify flag");
  assert.equal(JSON.parse(await store(["GET", "user:old@grace.org"])).verified, null);
});

test("an older account confirms its email on the account page", async () => {
  const store = memory();
  await call("signup", { ...owner, machine: machines[0] }, store);
  const login = await web(store, null, "POST", { action: "login", email: owner.email, password: owner.password });
  assert.equal(login.body.verified, false);
  const cookie = cookieOf(login);
  sent.length = 0;
  assert.equal((await web(store, cookie, "POST", { action: "sendConfirm" })).body.sent, true);
  assert.equal(sent[0].data.purpose, "verify");
  const confirmed = await web(store, cookie, "POST", { action: "confirmEmail", code: sent[0].data.code });
  assert.equal(confirmed.body.verified, true);
});
