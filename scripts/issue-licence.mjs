// Issues a licence key by hand, until payments issue them automatically.
//
//   node scripts/issue-licence.mjs --church "Grace Chapel" --months 12 [--plan standard]
//
// Signs with ~/.hearken/licence-signing-key.pem (or LICENCE_SIGNING_KEY), prints the key to
// send to the church, and records it in ~/.hearken/licences.jsonl.
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { DAY, makePass, now, signingKey } from "../lib/pass.js";

const { values: a } = parseArgs({ options: { church: { type: "string" }, plan: { type: "string", default: "standard" }, months: { type: "string", default: "12" }, days: { type: "string" } } });
if (!a.church) {
  console.error('Usage: node scripts/issue-licence.mjs --church "Church name" [--months 12 | --days 30] [--plan standard]');
  process.exit(1);
}
const pem = process.env.LICENCE_SIGNING_KEY ?? readFileSync(`${homedir()}/.hearken/licence-signing-key.pem`, "utf8");
const issued = now();
const expires = a.days ? issued + Number(a.days) * DAY : Math.floor(new Date(new Date(issued * 1000).setUTCMonth(new Date(issued * 1000).getUTCMonth() + Number(a.months))) / 1000);
const licence = { kind: "licence", id: randomUUID(), church: a.church, plan: a.plan, issued, expires };
const key = makePass(licence, signingKey(pem));
appendFileSync(`${homedir()}/.hearken/licences.jsonl`, JSON.stringify({ ...licence, key }) + "\n", { mode: 0o600 });
console.error(`Licence for ${a.church}, ${a.plan}, until ${new Date(expires * 1000).toDateString()}:\n`);
console.log(key);
