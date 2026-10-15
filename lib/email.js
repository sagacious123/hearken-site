// Sends email through Resend (RESEND_API_KEY and EMAIL_FROM on Vercel).
export async function sendEmail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error("email isn't set up (RESEND_API_KEY, EMAIL_FROM)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) throw new Error(`email failed: ${res.status} ${await res.text()}`);
}
