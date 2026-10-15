import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { optionalEnv } from '../env.js';
import { clientIp } from '../legal.js';
import { sendAccountEmail } from '../mailer.js';
import { publicOrigin } from '../oauth/common.js';

// Open sign-up, behind Cloudflare Turnstile. GoTrue's own /signup stays
// switched off in the dashboard: Supabase's CAPTCHA setting would also gate
// password sign-in, which every shipped iOS build does without a token. So
// this is the one door — the admin API's generate_link skips DisableSignup,
// creates the user unconfirmed, and hands back the confirmation link, which
// goes out over Resend like the invites do.
//
// Unauthenticated by nature, so no per-user limiter. The guards are the
// Turnstile check and a hard cap on accounts created per day: a bot that
// gets past the widget can spend the day's sign-ups, not the Resend quota
// that invites and password resets share.
//
// The reply is the same "check your inbox" whether the address is new,
// unconfirmed (a fresh link goes out) or already confirmed (nothing goes
// out), so the endpoint cannot be used to test which addresses have accounts.

export const MAX_SIGNUPS_PER_DAY = 50;
const MIN_PASSWORD = 8;
const MAX_EMAIL = 254;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const secret = optionalEnv('TURNSTILE_SECRET_KEY');
  const supabase = getSupabaseAdmin();
  if (!secret || !supabase) {
    res.status(503).json({ error: 'Sign-up is not open.' });
    return;
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : '';
  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (password.length < MIN_PASSWORD) {
    res.status(400).json({ error: `Use a password of at least ${MIN_PASSWORD} characters.` });
    return;
  }
  if (!captchaToken || !(await turnstilePasses(secret, captchaToken, clientIp(req)))) {
    res.status(400).json({ error: 'The human check failed — try again.' });
    return;
  }

  // handle_new_user() gives every auth.users row a profile, so profiles
  // created in the last day is the day's sign-ups (invites included).
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error: countErr } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  if (countErr) {
    console.error('[signup] count failed:', countErr.message);
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return;
  }
  if ((count ?? 0) >= MAX_SIGNUPS_PER_DAY) {
    console.error(`[signup] SIGNUP-DAILY-CAP reached (${MAX_SIGNUPS_PER_DAY})`);
    res.status(429).json({ error: 'Sign-up is busy right now — try again tomorrow.' });
    return;
  }

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'signup',
    email,
    password,
    options: { redirectTo: publicOrigin(req) },
  });
  if (error) {
    if (error.code === 'email_exists') {
      res.status(200).json({ status: 'pending' });
      return;
    }
    if (error.code === 'weak_password') {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('[signup] generateLink failed:', error.code, error.message);
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return;
  }

  try {
    await sendAccountEmail(confirmationEmail(email, data.properties.action_link));
  } catch (err) {
    console.error('[signup] confirmation email failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'We could not send the confirmation email — try again later.' });
    return;
  }
  res.status(200).json({ status: 'pending' });
}

async function turnstilePasses(secret: string, token: string, ip: string | null): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const reply = await fetch(SITEVERIFY, { method: 'POST', body: form });
    const json = (await reply.json()) as { success?: boolean };
    return json.success === true;
  } catch (err) {
    // Fails closed, unlike the rate limiter: this is the only thing standing
    // between the open internet and account creation.
    console.error('[signup] siteverify failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

function confirmationEmail(to: string, link: string) {
  return {
    to,
    subject: 'Confirm your Apex Training account',
    text: `Confirm your email to finish creating your Apex Training account:\n\n${link}\n\n`
      + 'If you did not ask for an account, ignore this email — it cannot be signed into until confirmed.',
    html: `<p>Confirm your email to finish creating your Apex Training account.</p>`
      + `<p><a href="${link}">Confirm my account</a></p>`
      + '<p>If you did not ask for an account, ignore this email — it cannot be signed into until confirmed.</p>',
  };
}
