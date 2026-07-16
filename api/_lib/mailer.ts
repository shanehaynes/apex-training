import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

// Review-email delivery over Gmail SMTP — no domain to verify, sends from the
// owner's own Gmail. Configured with GMAIL_USER (the address) and
// GMAIL_APP_PASSWORD (a 16-char app password from a 2FA-enabled Google
// account; Google renders it in four space-separated groups, so we strip
// whitespace to accept a pasted value). Gmail requires the From address to be
// the authenticated account, so From is derived from GMAIL_USER, not free.

export interface ReviewEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let cachedTransport: Transporter | null = null;

function getMailer(): { transport: Transporter; from: string } {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !pass) {
    throw new Error('Gmail not configured (GMAIL_USER / GMAIL_APP_PASSWORD)');
  }
  cachedTransport ??= nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return { transport: cachedTransport, from: `Apex Training <${user}>` };
}

export async function sendReviewEmail(email: ReviewEmail): Promise<void> {
  const { transport, from } = getMailer();
  await transport.sendMail({
    from,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}
