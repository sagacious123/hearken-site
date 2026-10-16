// Sends email through Hearken's mailer (the hearken-mailer project on Vercel), which renders its
// branded templates and delivers them over SMTP. MAILER_SECRET_KEY is one of its backend keys
// (MAILER_SECRET_KEYS there); MAILER_URL points somewhere else, e.g. a local copy.
export const MAILER_URL = process.env.MAILER_URL ?? "https://hearken-mailer.vercel.app/api/send";

/** `message` is the mailer's payload: { to, template, data, subject? }. */
export async function sendEmail(message) {
  const key = process.env.MAILER_SECRET_KEY;
  if (!key) throw new Error("email isn't set up (MAILER_SECRET_KEY)");
  const res = await fetch(MAILER_URL, {
    method: "POST",
    headers: { "x-sdk-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`email failed: ${res.status} ${await res.text()}`);
}
