// Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), and the
// encryption that keeps each admin's secret unreadable in storage.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP = 30;

export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one 30-second step (RFC 4226's dynamic truncation, 6 digits). */
export function codeAt(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const at = h[h.length - 1] & 15;
  return String((h.readUInt32BE(at) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

/** Which step `code` belongs to, allowing one step either side for clock drift; null if none. */
export function matchCode(secret, code, unix = Date.now() / 1000) {
  const typed = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = Math.floor(unix / STEP);
  for (const counter of [now, now - 1, now + 1]) if (codeAt(secret, counter) === typed) return counter;
  return null;
}

export const newSecret = () => randomBytes(20);

/** The link an authenticator app reads from the QR code. */
export const otpauthUri = (secret, account, issuer = "Hearken Studio") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

/** Secrets are stored sealed with AES-256-GCM, under a key derived from the site's signing key. */
const sealKey = () => createHash("sha256").update(`hearken-totp:${process.env.LICENCE_SIGNING_KEY ?? ""}`).digest();

export function seal(secret) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(), iv);
  const body = Buffer.concat([c.update(secret), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function unseal(sealed) {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", sealKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}
