// /api/admin: the admin dashboard's data and actions.
//
// Getting in takes two steps: being signed in on the account page as an admin email, then a
// second step: a code from an authenticator app once one is set up, or else a code emailed to
// that address. That opens an admin sign-in in its own strict cookie, for 12 hours, or 30 days
// when the browser is trusted.
//
//   GET                                       → the overview (admin signed in) or 401
//   POST { action: "status" }                 → where the visitor is in getting in
//   POST { action: "code" }                   → emails a code
//   POST { action: "verify", code, method: "app" | "email", trust }
//                                             → the admin sign-in, and the overview
//   POST { action: "logout" }
//   POST { action: "totpBegin" }              → a new authenticator secret and its QR link
//   POST { action: "totpConfirm", code }      → keeps it, once a code from it is right
//   POST { action: "totpRemove", code }       → needs a current code from it
//   POST { action: "account", email }         → one account in detail
//   POST { action: "issue", email, plan, months | days, send }
//   POST { action: "revoke", email }
//   POST { action: "remove", email, id }      → signs one computer out
//   POST { action: "signOutAll", email }      → every computer and website sign-in
//   POST { action: "resetEmail", email }      → sends a password-reset email
//   POST { action: "rename", email, church }
//   POST { action: "delete", email, confirm } → confirm must repeat the email
import { randomUUID } from "node:crypto";
import {
  accountSummary, allowed, body, checkCode, computerId, describeComputers, fail, forgetComputer, getComputers, getUser,
  newToken, normalEmail, readLicence, saveComputers, saveUser, sendCode, sha256,
} from "../lib/auth.js";
import { SITE, sendEmail } from "../lib/email.js";
import { kv } from "../lib/kv.js";
import { DAY, TRIAL_DAYS, makePass, now, signingKey } from "../lib/pass.js";
import { base32, matchCode, newSecret, otpauthUri, seal, unseal } from "../lib/totp.js";
import { ACCOUNT, sameSite, setCookie, signedIn, startSignIn } from "../lib/web.js";

/** Who can open the dashboard. More can be added on Vercel: ADMIN_EMAILS="a@x.org,b@y.org". */
const ADMINS = new Set(["damilolaj23@gmail.com", ...String(process.env.ADMIN_EMAILS ?? "").split(",").map(normalEmail).filter(Boolean)]);
const ADMIN = { name: "hk_admin", prefix: "admin", seconds: 12 * 3600, sameSite: "Strict" };
const TRUSTED_SECONDS = 30 * 24 * 3600;

/** The admin's authenticator secret, if one is set up. */
const authenticator = async (store, email) => {
  const sealed = await store(["GET", `totp:${email}`]);
  return sealed ? unseal(sealed) : null;
};

/**
 * Checks an authenticator code: each 30-second code works once (the last step used is kept),
 * and guessing is limited.
 */
async function totpOk(store, email, secret, code) {
  if (!(await allowed(store, `admin-totp:${email}`, 10, 900))) return false;
  const counter = matchCode(secret, code);
  if (counter === null) return false;
  const last = Number((await store(["GET", `totp-used:${email}`])) ?? -1);
  if (counter <= last) return false;
  await store(["SET", `totp-used:${email}`, String(counter), "EX", 120]);
  return true;
}
const GRACE_DAYS = 14;
const LOG = "licences:log";

export const isAdmin = (email) => ADMINS.has(email);

/** Every key matching `pattern` (Redis SCAN, a page at a time). */
async function keys(store, pattern) {
  const found = [];
  let cursor = "0";
  do {
    const [next, batch] = await store(["SCAN", cursor, "MATCH", pattern, "COUNT", 1000]);
    found.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");
  return found;
}

/** Many values at once, in batches. */
async function values(store, list) {
  const out = [];
  for (let i = 0; i < list.length; i += 200) out.push(...(await store(["MGET", ...list.slice(i, i + 200)])));
  return out;
}

const json = (raw) => (raw ? JSON.parse(raw) : null);
const weekStart = (unix) => {
  const d = new Date(unix * 1000);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return Math.floor(d / 1000);
};

/** Counts per week for the last `weeks` weeks, oldest first. */
function perWeek(times, weeks, t) {
  const first = weekStart(t) - (weeks - 1) * 7 * DAY;
  const counts = Array.from({ length: weeks }, (_, i) => ({ week: first + i * 7 * DAY, count: 0 }));
  for (const time of times) {
    const i = Math.floor((weekStart(time) - first) / (7 * DAY));
    if (i >= 0 && i < weeks) counts[i].count++;
  }
  return counts;
}

function licenceState(licence, t) {
  if (!licence) return null;
  if (licence.expires > t) return "active";
  return licence.expires + GRACE_DAYS * DAY > t ? "grace" : "ended";
}

/** Everything the dashboard's front page shows. */
async function overview(store) {
  const t = now();
  const users = (await values(store, await keys(store, "user:*"))).map(json).filter(Boolean);
  const [lists, licences] = users.length
    ? await Promise.all([values(store, users.map((u) => `computers:${u.id}`)), values(store, users.map((u) => `licence:${u.id}`))])
    : [[], []];
  const trialKeys = await keys(store, "trial:*");
  const trials = (await values(store, trialKeys)).map((raw, i) => ({ machine: trialKeys[i].slice(6), ...json(raw) }));
  const trialOf = new Map(trials.map((tr) => [tr.machine, tr]));

  const accounts = users.map((u, i) => {
    const list = json(lists[i]) ?? {};
    const machines = Object.keys(list);
    const ends = machines.map((m) => trialOf.get(m)).filter(Boolean).map((tr) => tr.starts + TRIAL_DAYS * DAY);
    const licence = readLicence(licences[i]);
    return {
      email: u.email,
      church: u.church,
      created: u.created,
      computers: machines.length,
      lastUsed: Math.max(0, ...machines.map((m) => list[m].last ?? 0)) || null,
      trialEnds: ends.length ? Math.max(...ends) : null,
      licence: licence && { plan: licence.plan, expires: licence.expires, state: licenceState(licence, t) },
      admin: isAdmin(u.email),
      verified: Boolean(u.verified),
    };
  });
  accounts.sort((a, b) => b.created - a.created);

  const computers = users.flatMap((_, i) => Object.values(json(lists[i]) ?? {}));
  // Every computer with its church, and every trial with the church it's signed in to (if any).
  const owner = new Map();
  const computerList = users.flatMap((u, i) =>
    Object.entries(json(lists[i]) ?? {}).map(([machine, c]) => {
      owner.set(machine, u);
      const tr = trialOf.get(machine);
      return { id: computerId(machine), name: c.name || "Unnamed computer", church: u.church, email: u.email, first: c.first, last: c.last, trialEnds: tr ? tr.starts + TRIAL_DAYS * DAY : null };
    }),
  ).sort((a, b) => b.last - a.last);
  const trialList = trials
    .map((tr) => ({ id: computerId(tr.machine), version: tr.version || null, starts: tr.starts, ends: tr.starts + TRIAL_DAYS * DAY, registered: tr.registered ?? null, church: owner.get(tr.machine)?.church ?? null, email: owner.get(tr.machine)?.email ?? null }))
    .sort((a, b) => b.starts - a.starts);
  const versions = {};
  for (const tr of trials) if (tr.version) versions[tr.version] = (versions[tr.version] ?? 0) + 1;
  const count = (list, test) => list.filter(test).length;
  const states = accounts.map((a) => a.licence?.state);

  return {
    generated: t,
    stats: {
      accounts: users.length,
      accountsWeek: count(users, (u) => u.created > t - 7 * DAY),
      accountsMonth: count(users, (u) => u.created > t - 30 * DAY),
      unverified: count(users, (u) => !u.verified),
      computers: computers.length,
      activeToday: count(computers, (c) => c.last > t - DAY),
      activeWeek: count(computers, (c) => c.last > t - 7 * DAY),
      trials: trials.length,
      trialsActive: count(trials, (tr) => tr.starts + TRIAL_DAYS * DAY > t),
      trialsWeek: count(trials, (tr) => tr.starts > t - 7 * DAY),
      licencesActive: count(states, (s) => s === "active"),
      licencesGrace: count(states, (s) => s === "grace"),
      licencesEnded: count(states, (s) => s === "ended"),
    },
    weeks: { accounts: perWeek(users.map((u) => u.created), 12, t), trials: perWeek(trials.map((tr) => tr.starts), 12, t) },
    versions: Object.entries(versions).sort((a, b) => b[1] - a[1]).map(([version, n]) => ({ version, n })),
    accounts,
    computers: computerList,
    trials: trialList,
    log: (await store(["LRANGE", LOG, 0, 99])).map(json),
  };
}

/** One account in full, for its detail panel. */
async function detail(store, user) {
  const summary = await accountSummary(store, user);
  const list = await getComputers(store, user);
  // When each computer first signed in, beside what the account page shows.
  const first = Object.fromEntries(describeComputers(list).map((c) => [c.id, c.first]));
  return { ...summary, computers: summary.computers.map((c) => ({ ...c, first: first[c.id] ?? null })), admin: isAdmin(user.email) };
}

const record = (store, entry) => store(["LPUSH", LOG, JSON.stringify({ at: now(), ...entry })]).then(() => store(["LTRIM", LOG, 0, 499]));

function months(from, n) {
  const d = new Date(from * 1000);
  d.setUTCMonth(d.getUTCMonth() + n);
  return Math.floor(d / 1000);
}

export default async function handler(req, res, store = kv) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  try {
    const account = await signedIn(req, store, ACCOUNT.name, ACCOUNT.prefix);
    const admin = await signedIn(req, store, ADMIN.name, ADMIN.prefix);
    const verified = admin && isAdmin(admin.user.email) && account?.user.email === admin.user.email ? admin : null;

    if (req.method === "GET") return verified ? res.status(200).json(await overview(store)) : fail(res, 401, "Not signed in as an admin.");
    if (req.method !== "POST") return fail(res, 405, "GET or POST only");
    if (!sameSite(req)) return fail(res, 403, "bad request");
    const b = body(req);

    if (b.action === "status") {
      const admin = !!account && isAdmin(account.user.email);
      const totp = admin && !!(await store(["GET", `totp:${account.user.email}`]));
      return res.status(200).json({ signedIn: !!account, email: account?.user.email ?? null, admin, verified: !!verified, totp });
    }

    if (b.action === "code") {
      if (!account || !isAdmin(account.user.email)) return fail(res, 403, "This account isn't an admin.");
      const email = account.user.email;
      if (!(await allowed(store, `admincode:${email}`, 5, 3600))) return fail(res, 429, "Too many codes. Wait an hour and try again.");
      await sendCode(store, `admin-code:${email}`, email, "sign-in", 10);
      return res.status(200).json({ sent: true });
    }

    if (b.action === "verify") {
      if (!account || !isAdmin(account.user.email)) return fail(res, 403, "This account isn't an admin.");
      const email = account.user.email;
      if (b.method === "app") {
        const secret = await authenticator(store, email);
        if (!secret) return fail(res, 400, "No authenticator is set up. Use an emailed code.");
        if (!(await totpOk(store, email, secret, b.code))) return fail(res, 400, "That code isn’t right. Use the newest code in your authenticator app.");
      } else {
        const checked = await checkCode(store, `admin-code:${email}`, b.code, 10);
        if (checked.error) return fail(res, 400, checked.error);
      }
      await startSignIn(res, store, account.user, { ...ADMIN, seconds: b.trust ? TRUSTED_SECONDS : ADMIN.seconds });
      return res.status(200).json(await overview(store));
    }

    if (b.action === "logout") {
      if (admin) await store(["DEL", `${ADMIN.prefix}:${sha256(admin.token)}`]);
      setCookie(res, ADMIN.name, "", 0, ADMIN.sameSite);
      return res.status(200).json({ ok: true });
    }

    if (!verified) return fail(res, 401, "Your admin sign-in has ended. Sign in again.");
    const me = verified.user.email;

    if (b.action === "totpBegin") {
      const secret = newSecret();
      await store(["SET", `totp-pending:${me}`, seal(secret), "EX", 900]);
      return res.status(200).json({ uri: otpauthUri(secret, me), secret: base32(secret) });
    }
    if (b.action === "totpConfirm") {
      const pending = await store(["GET", `totp-pending:${me}`]);
      if (!pending) return fail(res, 400, "This set-up has expired. Start again.");
      if (!(await totpOk(store, me, unseal(pending), b.code))) return fail(res, 400, "That code isn’t right. Type the code your authenticator app shows now.");
      await store(["SET", `totp:${me}`, pending]);
      await store(["DEL", `totp-pending:${me}`]);
      return res.status(200).json({ totp: true });
    }
    if (b.action === "totpRemove") {
      const secret = await authenticator(store, me);
      if (!secret) return res.status(200).json({ totp: false });
      if (!(await totpOk(store, me, secret, b.code))) return fail(res, 400, "That code isn’t right. Type the code your authenticator app shows now.");
      await store(["DEL", `totp:${me}`]);
      return res.status(200).json({ totp: false });
    }

    const user = await getUser(store, normalEmail(b.email));
    if (!user) return fail(res, 404, "There's no account with that email.");
    const by = verified.user.email;

    switch (b.action) {
      case "account":
        return res.status(200).json(await detail(store, user));

      case "issue": {
        const plan = typeof b.plan === "string" && b.plan.trim() ? b.plan.trim().slice(0, 40) : "standard";
        const issued = now();
        const days = Number(b.days);
        const n = Number(b.months);
        const expires = days > 0 && days <= 3660 ? issued + Math.round(days) * DAY : n > 0 && n <= 120 ? months(issued, Math.round(n)) : null;
        if (!expires) return fail(res, 400, "Choose how long the licence lasts.");
        const licence = { kind: "licence", id: randomUUID(), church: user.church, plan, issued, expires };
        const key = makePass(licence, signingKey());
        await store(["SET", `licence:${user.id}`, key]);
        await record(store, { action: "issued", email: user.email, church: user.church, plan, expires, by, id: licence.id });
        if (b.send) {
          const until = new Date(expires * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
          await sendEmail({
            to: user.email,
            template: "message",
            data: {
              subject: "Your Hearken Studio licence",
              heading: "Your licence is ready",
              name: user.church,
              message: `Your Hearken Studio licence (${plan} plan, until ${until}) is on your account. Computers signed in to it receive it by themselves the next time they’re online.\n\nTo add it by hand, open Settings → Account and licence in Hearken Studio and paste this key:\n\n${key}`,
              actionUrl: `${SITE}/account`,
              actionLabel: "See your account",
            },
          });
        }
        return res.status(200).json(await detail(store, user));
      }

      case "revoke":
        await store(["DEL", `licence:${user.id}`]);
        await record(store, { action: "revoked", email: user.email, church: user.church, by });
        return res.status(200).json(await detail(store, user));

      case "remove": {
        const list = await getComputers(store, user);
        const machine = Object.keys(list).find((m) => computerId(m) === b.id);
        if (machine) {
          await forgetComputer(store, list, machine);
          await saveComputers(store, user, list);
        }
        return res.status(200).json(await detail(store, user));
      }

      case "signOutAll":
        // A new version ends every app session and website sign-in of this account.
        user.version = (user.version ?? 0) + 1;
        await saveUser(store, user);
        await store(["DEL", `computers:${user.id}`]);
        return res.status(200).json(await detail(store, user));

      case "resetEmail": {
        const token = newToken();
        await store(["SET", `reset:${sha256(token)}`, user.email, "EX", 3600]);
        await sendEmail({ to: user.email, template: "password-reset", data: { url: `${SITE}/reset?token=${token}`, expiresInMinutes: 60 } });
        return res.status(200).json({ sent: true });
      }

      case "rename": {
        const church = typeof b.church === "string" ? b.church.trim() : "";
        if (!church || church.length > 120) return fail(res, 400, "Enter the church's name.");
        user.church = church;
        await saveUser(store, user);
        return res.status(200).json(await detail(store, user));
      }

      case "delete": {
        if (normalEmail(b.confirm) !== user.email) return fail(res, 400, "Type the account's email to confirm.");
        if (isAdmin(user.email)) return fail(res, 400, "Admin accounts can't be deleted here.");
        const list = await getComputers(store, user);
        for (const machine of Object.keys(list)) await forgetComputer(store, list, machine);
        await Promise.all([store(["DEL", `user:${user.email}`]), store(["DEL", `computers:${user.id}`]), store(["DEL", `licence:${user.id}`])]);
        await record(store, { action: "deleted", email: user.email, church: user.church, by });
        return res.status(200).json({ deleted: true });
      }

      default:
        return fail(res, 400, "bad request");
    }
  } catch (e) {
    console.error("admin:", e.message);
    return fail(res, 503, "The service isn't available right now. Try again in a few minutes.");
  }
}
