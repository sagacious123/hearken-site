// node --test: the admin dashboard, with an in-memory store, a throwaway signing key and the
// mailer replaced by a list of what would have been sent.
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
const admin = (await import("../api/admin.js")).default;
const account = (await import("../api/account.js")).default;
const auth = Object.fromEntries(await Promise.all(["signup", "login", "refresh"].map(async (n) => [n, (await import(`../api/auth/${n}.js`)).default])));

const memory = () => {
  const m = new Map();
  const glob = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return async ([cmd, key, ...rest]) => {
    if (cmd === "GET") return m.get(key) ?? null;
    if (cmd === "MGET") return [key, ...rest].map((k) => m.get(k) ?? null);
    if (cmd === "DEL") return m.delete(key) ? 1 : 0;
    if (cmd === "INCR") return m.set(key, (m.get(key) ?? 0) + 1).get(key);
    if (cmd === "EXPIRE") return 1;
    if (cmd === "SET") {
      if (rest.includes("NX") && m.has(key)) return null;
      m.set(key, rest[0]);
      return "OK";
    }
    if (cmd === "SCAN") return ["0", [...m.keys()].filter((k) => glob(rest[1]).test(k))];
    if (cmd === "LPUSH") return m.set(key, [rest[0], ...(m.get(key) ?? [])]).get(key).length;
    if (cmd === "LRANGE") return (m.get(key) ?? []).slice(Number(rest[0]), Number(rest[1]) + 1);
    if (cmd === "LTRIM") return m.set(key, (m.get(key) ?? []).slice(Number(rest[0]), Number(rest[1]) + 1)) && "OK";
    throw new Error(cmd);
  };
};
const reply = () => ({ code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
/** A browser on the site: keeps its cookies between calls. */
const browser = (store) => {
  const jar = {};
  const go = (fn) => async (method, body, origin = "https://hearken.test") => {
    const res = reply();
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    await fn({ method, body, headers: { host: "hearken.test", origin, cookie } }, res, store);
    const set = res.headers["Set-Cookie"];
    if (set) {
      const [k, v] = set.split(";")[0].split("=");
      v ? (jar[k] = v) : delete jar[k];
    }
    return res;
  };
  return { admin: go(admin), account: go(account) };
};
const app = async (name, body, store) => {
  const res = reply();
  await auth[name]({ method: "POST", body, headers: {} }, res, store);
  return res;
};
const ADMIN = { church: "Hearken", email: "damilolaj23@gmail.com", password: "admin password" };
const church = { church: "Grace Chapel", email: "media@grace.org", password: "hallelujah" };
const machine = (c) => c.repeat(64);

/** An admin browser that has been through the code step. */
/** Signs up on the website: the details, then the emailed code. */
async function signUp(b, fields) {
  await b.account("POST", { action: "signup", ...fields });
  return b.account("POST", { action: "verifySignup", email: fields.email, code: sent.filter((m) => m.to === fields.email).at(-1).data.code });
}

async function signedInAdmin(store) {
  const b = browser(store);
  await signUp(b, ADMIN);
  sent.length = 0;
  await b.admin("POST", { action: "code" });
  await b.admin("POST", { action: "verify", code: sent.at(-1).data.code });
  return b;
}

test("getting in takes an admin email and the emailed code", async () => {
  const store = memory();
  const visitor = browser(store);
  assert.equal((await visitor.admin("GET")).code, 401);
  assert.deepEqual((await visitor.admin("POST", { action: "status" })).body, { signedIn: false, email: null, admin: false, verified: false, totp: false });

  await signUp(visitor, church);
  assert.equal((await visitor.admin("POST", { action: "code" })).code, 403, "a church account isn't an admin");

  const b = browser(store);
  await signUp(b, ADMIN);
  assert.equal((await b.admin("POST", { action: "status" })).body.admin, true);
  sent.length = 0;
  assert.equal((await b.admin("POST", { action: "code" })).code, 200);
  assert.equal(sent[0].to, ADMIN.email);
  assert.equal(sent[0].template, "verification-code");
  const code = sent[0].data.code;
  assert.match(code, /^\d{6}$/);
  assert.equal((await b.admin("POST", { action: "verify", code: code === "000000" ? "111111" : "000000" })).code, 400);
  assert.equal((await b.admin("GET")).code, 401, "not in yet");
  const ok = await b.admin("POST", { action: "verify", code });
  assert.equal(ok.code, 200);
  assert.match(ok.headers["Set-Cookie"], /^hk_admin=.*SameSite=Strict/);
  assert.equal((await b.admin("POST", { action: "verify", code })).code, 400, "a code works once");
  assert.equal((await b.admin("GET")).code, 200);
  assert.equal((await b.admin("POST", { action: "account", email: church.email }, "https://evil.example")).code, 403);

  // Signing out of the account page closes the dashboard too.
  await b.account("POST", { action: "logout" });
  assert.equal((await b.admin("GET")).code, 401);
});

test("the overview counts accounts, computers, trials and licences", async () => {
  const store = memory();
  const b = await signedInAdmin(store);
  await app("signup", { ...church, machine: machine("a"), name: "Media desk" }, store);
  await app("login", { email: church.email, password: church.password, machine: machine("b"), name: "Office" }, store);
  await app("signup", { church: "Hope Church", email: "av@hope.org", password: "password1", machine: machine("c") }, store);
  const t = Math.floor(Date.now() / 1000);
  await store(["SET", `trial:${machine("a")}`, JSON.stringify({ starts: t - 5 * 86400, version: "0.3.0" })]);
  await store(["SET", `trial:${machine("c")}`, JSON.stringify({ starts: t - 70 * 86400, version: "0.2.0" })]);

  const o = (await b.admin("GET")).body;
  assert.equal(o.stats.accounts, 3);
  assert.equal(o.stats.accountsWeek, 3);
  assert.equal(o.stats.computers, 3);
  assert.equal(o.stats.activeToday, 3);
  assert.equal(o.stats.trials, 2);
  assert.equal(o.stats.trialsActive, 1);
  assert.deepEqual(o.versions, [{ version: "0.3.0", n: 1 }, { version: "0.2.0", n: 1 }]);
  assert.equal(o.weeks.accounts.length, 12);
  assert.equal(o.weeks.accounts.at(-1).count, 3);
  const grace = o.accounts.find((a) => a.email === church.email);
  assert.equal(grace.computers, 2);
  assert.equal(grace.trialEnds, t - 5 * 86400 + 60 * 86400);
});

test("an admin issues, emails and revokes a licence, and the app receives it", async () => {
  const store = memory();
  const b = await signedInAdmin(store);
  const desk = await app("signup", { ...church, machine: machine("a") }, store);
  sent.length = 0;
  assert.equal((await b.admin("POST", { action: "issue", email: church.email, plan: "standard" })).code, 400, "needs a length");
  const issued = await b.admin("POST", { action: "issue", email: church.email, plan: "standard", months: 12, send: true });
  assert.equal(issued.code, 200);
  assert.equal(issued.body.licence.plan, "standard");
  assert.equal(sent[0].to, church.email);
  assert.equal(sent[0].template, "message");
  assert.ok(sent[0].data.message.includes(issued.body.licence.key), "the email carries the key");

  const renewed = await app("refresh", { session: desk.body.session, machine: machine("a") }, store);
  assert.equal(renewed.body.licence, issued.body.licence.key);
  const payload = JSON.parse(Buffer.from(renewed.body.licence.split(".")[1], "base64url"));
  assert.equal(payload.church, "Grace Chapel");

  await b.admin("POST", { action: "revoke", email: church.email });
  assert.equal((await app("refresh", { session: desk.body.session, machine: machine("a") }, store)).body.licence, null);
  const log = (await b.admin("GET")).body.log;
  assert.deepEqual(log.map((e) => e.action), ["revoked", "issued"]);
  assert.equal(log[1].by, ADMIN.email);
});

test("an admin signs computers out, sends resets, renames and deletes", async () => {
  const store = memory();
  const b = await signedInAdmin(store);
  const desk = await app("signup", { ...church, machine: machine("a"), name: "Media desk" }, store);
  const office = await app("login", { email: church.email, password: church.password, machine: machine("b"), name: "Office" }, store);

  const d = (await b.admin("POST", { action: "account", email: church.email })).body;
  assert.equal(d.computers.length, 2);
  const after = await b.admin("POST", { action: "remove", email: church.email, id: d.computers.find((c) => c.name === "Office").id });
  assert.equal(after.body.computers.length, 1);
  assert.equal((await app("refresh", { session: office.body.session, machine: machine("b") }, store)).code, 401);

  sent.length = 0;
  await b.admin("POST", { action: "resetEmail", email: church.email });
  assert.equal(sent[0].template, "password-reset");

  assert.equal((await b.admin("POST", { action: "rename", email: church.email, church: "Grace Chapel Ikeja" })).body.church, "Grace Chapel Ikeja");

  await b.admin("POST", { action: "signOutAll", email: church.email });
  assert.equal((await app("refresh", { session: desk.body.session, machine: machine("a") }, store)).code, 401, "every computer signed out");

  assert.equal((await b.admin("POST", { action: "delete", email: church.email, confirm: "someone@else.org" })).code, 400);
  assert.equal((await b.admin("POST", { action: "delete", email: ADMIN.email, confirm: ADMIN.email })).code, 400, "admins can't be deleted here");
  assert.equal((await b.admin("POST", { action: "delete", email: church.email, confirm: church.email })).body.deleted, true);
  assert.equal((await b.admin("POST", { action: "account", email: church.email })).code, 404);
  assert.equal((await app("login", { email: church.email, password: church.password, machine: machine("a") }, store)).code, 401);
});

test("an authenticator app replaces the emailed code, and a browser can be trusted", async () => {
  const { codeAt, fromBase32 } = await import("../lib/totp.js");
  const store = memory();
  const b = await signedInAdmin(store);
  assert.equal((await b.admin("POST", { action: "status" })).body.totp, false);

  // Set up: scan, then prove it with a code.
  const begun = await b.admin("POST", { action: "totpBegin" });
  assert.match(begun.body.uri, /^otpauth:\/\/totp\/Hearken%20Studio%3Adamilolaj23%40gmail\.com\?secret=/);
  const secret = fromBase32(begun.body.secret);
  const step = Math.floor(Date.now() / 1000 / 30);
  assert.equal((await b.admin("POST", { action: "totpConfirm", code: "000000" === codeAt(secret, step) ? "111111" : "000000" })).code, 400);
  assert.equal((await b.admin("POST", { action: "totpConfirm", code: codeAt(secret, step) })).body.totp, true);
  assert.ok(!(await store(["GET", "totp:damilolaj23@gmail.com"])).includes(begun.body.secret), "kept sealed, not as typed");

  // Another browser: account sign-in, then the app's code instead of an email.
  const other = browser(store);
  await other.account("POST", { action: "login", email: ADMIN.email, password: ADMIN.password });
  assert.equal((await other.admin("POST", { action: "status" })).body.totp, true);
  sent.length = 0;
  assert.equal((await other.admin("POST", { action: "verify", method: "app", code: codeAt(secret, step) })).code, 400, "a code works once");
  const signedIn = await other.admin("POST", { action: "verify", method: "app", code: codeAt(secret, step + 1), trust: true });
  assert.equal(signedIn.code, 200);
  assert.match(signedIn.headers["Set-Cookie"], /Max-Age=2592000/, "trusted for 30 days");
  assert.equal(sent.length, 0, "no email needed");

  // The emailed code still works as a fallback, for 12 hours.
  const third = browser(store);
  await third.account("POST", { action: "login", email: ADMIN.email, password: ADMIN.password });
  await third.admin("POST", { action: "code" });
  const fallback = await third.admin("POST", { action: "verify", method: "email", code: sent.at(-1).data.code });
  assert.match(fallback.headers["Set-Cookie"], /Max-Age=43200/);

  // Removing it needs a current code, one not used yet: a minute later, the app shows a new one.
  assert.equal((await other.admin("POST", { action: "totpRemove", code: "123" })).code, 400);
  assert.equal((await other.admin("POST", { action: "totpRemove", code: codeAt(secret, step + 1) })).code, 400, "already used");
  await store(["DEL", "totp-used:damilolaj23@gmail.com"]);
  assert.equal((await other.admin("POST", { action: "totpRemove", code: codeAt(secret, step + 1) })).body.totp, false);
  assert.equal((await other.admin("POST", { action: "status" })).body.totp, false);
});

test("authenticator codes match RFC 6238", async () => {
  const { codeAt } = await import("../lib/totp.js");
  const secret = Buffer.from("12345678901234567890");
  assert.equal(codeAt(secret, Math.floor(59 / 30), 8), "94287082");
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30), 8), "07081804");
  assert.equal(codeAt(secret, Math.floor(20000000000 / 30), 8), "65353130");
});
