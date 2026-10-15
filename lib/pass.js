// Signed passes for the app: `HK1.<payload>.<signature>`, where the payload is base64url JSON
// and the signature is Ed25519 over `HK1.<payload>`. The app checks them offline with the
// matching public key (src-tauri/src/licence/token.rs in the app repo).
import { createPrivateKey, sign } from "node:crypto";

export const DAY = 86_400;
export const TRIAL_DAYS = 60;

/** The private key: LICENCE_SIGNING_KEY (PKCS#8 PEM) on Vercel, or a file when run locally. */
export function signingKey(pem = process.env.LICENCE_SIGNING_KEY) {
  if (!pem) throw new Error("LICENCE_SIGNING_KEY isn't set");
  return createPrivateKey(pem.replace(/\\n/g, "\n"));
}

export function makePass(payload, key) {
  const signed = "HK1." + Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
}

export const now = () => Math.floor(Date.now() / 1000);
export const isHex = (s, min, max) => typeof s === "string" && new RegExp(`^[0-9a-f]{${min},${max}}$`).test(s);
