import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { optionalEnv } from './env.js';

// Review-email delivery over Resend's SMTP relay, from the apex-training.app
// domain verified in Resend (DEPLOY_MULTI_USER.md §5). Configured with
// RESEND_API_KEY, a key with Sending access only, so a leak can send mail as
// the domain but read nothing. Nobody reads reviews@, so Reply-To points at
// support@, which Cloudflare Email Routing forwards to Shane.

const FROM = 'Apex Training <reviews@apex-training.app>';
const REPLY_TO = 'support@apex-training.app';

export interface ReviewEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let cachedTransport: Transporter | null = null;

function getMailer(): Transporter {
  const pass = optionalEnv('RESEND_API_KEY');
  if (!pass) {
    throw new Error('Resend not configured (RESEND_API_KEY)');
  }
  cachedTransport ??= nodemailer.createTransport({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    auth: { user: 'resend', pass },
  });
  return cachedTransport;
}

export async function sendReviewEmail(email: ReviewEmail): Promise<void> {
  await sendFrom(FROM, email);
}

// Sign-up confirmations (handlers/signup.ts) go out from the same address as
// the Supabase invites, so a new account's first mail looks like an invited
// one's.
const ACCOUNT_FROM = 'Apex Training <invites@apex-training.app>';

export async function sendAccountEmail(email: ReviewEmail): Promise<void> {
  await sendFrom(ACCOUNT_FROM, email);
}

async function sendFrom(from: string, email: ReviewEmail): Promise<void> {
  await getMailer().sendMail({
    from,
    replyTo: REPLY_TO,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}
