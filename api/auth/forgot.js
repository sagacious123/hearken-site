// POST /api/auth/forgot { email } → { ok }
//
// Emails a link to reset the password, valid for an hour. Answers the same whether or not the
// account exists, so it can't be used to find out who has one.
import { allowed, body, clientIp, fail, getUser, newToken, normalEmail, sha256 } from "../../lib/auth.js";
import { sendEmail } from "../../lib/email.js";
import { post } from "../../lib/handler.js";

export const SITE = process.env.SITE_URL ?? "https://hearken-site.vercel.app";

export default post(async (req, res, store) => {
  const email = normalEmail(body(req).email);
  if (!email) return fail(res, 400, "Enter your email address.");
  if (!(await allowed(store, `forgot:${email}`, 3, 3600)) || !(await allowed(store, `forgot-ip:${clientIp(req)}`, 20, 3600))) {
    return fail(res, 429, "Too many reset emails. Check your inbox and spam folder, or try again in an hour.");
  }
  const user = await getUser(store, email);
  if (user) {
    const token = newToken();
    await store(["SET", `reset:${sha256(token)}`, user.email, "EX", 3600]);
    const link = `${SITE}/reset?token=${token}`;
    await sendEmail({
      to: user.email,
      subject: "Reset your Hearken Studio password",
      text: `Someone asked to reset the password for ${user.church}'s Hearken Studio account.\n\nTo choose a new password, open this link within an hour:\n${link}\n\nIf it wasn't you, ignore this email: your password hasn't changed.`,
    });
  }
  return res.status(200).json({ ok: true });
});
