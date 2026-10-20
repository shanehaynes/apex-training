import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { optionalEnv } from '../env.js';
import { clientIp } from '../legal.js';
import { sendAccountEmail } from '../mailer.js';
import { publicOrigin } from '../oauth/common.js';

// Open sign-up, behind Cloudflare Turnstile. GoTrue's own /signup stays
// switched off in the dashboard: Supabase's CAPTCHA setting would also gate
// password sign-in, which every shipped iOS build does without a token. So
// this is the one door.
//
// It sends an *invite*, not a signup confirmation, and takes no password.
// A password chosen before the address is proven lets whoever asks first
// squat an address and own the account its real owner later confirms. With
// an invite, nobody holds a password until the mailbox owner clicks the link
// and lands on the set-password screen — the same path every invitee takes,
// and the admin API's generate_link skips DisableSignup to get there.
//
// Unauthenticated by nature, so the guards are: the Turnstile check (fails
// closed), at most MAILS_PER_ADDRESS mails per address per UTC day, and at
// most MAILS_PER_DAY in all, so a bot that gets past the widget spends the
// day's sign-ups, not the Resend quota that invites and resets share. The
// day's total is read then bumped, not reserved: concurrent requests at the
// edge can overshoot it by their number.
//
// The per-address check runs before generate_link, never after: for a
// pending address generate_link rotates the invite token, so a throttled
// request that still called it would kill the link the owner already holds.
// That needs the user looked up first (GoTrue's admin user search); a new
// address has no link to kill and is metered once it exists.
//
// The reply is the same "check your inbox" whether the address is new,
// already invited, throttled or a confirmed account (which is mailed
// nothing), so the body never says which addresses have accounts. The
// confirmed case skips the mail round trip, so its latency still differs.

export const MAILS_PER_DAY = 50;
export const MAILS_PER_ADDRESS = 3;
const BUCKET = 'signup_mail';
const DAY = 86400;
const MAX_EMAIL = 254;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 5000;
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
  const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : '';
  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  // The terms require 18+ (legal/terms-v1.md §2); the attestation is its own
  // act on the form, and refused here before anything else is spent.
  if (body.ageConfirmed !== true) {
    res.status(400).json({ error: 'Please confirm you are 18 or older to continue.' });
    return;
  }
  if (!captchaToken || !(await turnstilePasses(secret, captchaToken, clientIp(req)))) {
    res.status(400).json({ error: 'The human check failed — try again.' });
    return;
  }

  // Bucket rows are per user and per UTC day (bump_rate_limit's fixed window),
  // so today's rows summed are today's sign-up mails.
  const today = new Date(Math.floor(Date.now() / 1000 / DAY) * DAY * 1000).toISOString();
  const { data: rows, error: countErr } = await supabase
    .from('api_request_counts')
    .select('count')
    .eq('bucket', BUCKET)
    .gte('window_start', today);
  if (countErr) {
    console.error('[signup] count failed:', countErr.message);
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return;
  }
  // Requests past an address's limit bump its row but send nothing, so a row
  // counts for at most MAILS_PER_ADDRESS mails.
  const sent = (rows ?? []).reduce(
    (sum, r) => sum + Math.min(Number((r as { count: number }).count), MAILS_PER_ADDRESS),
    0,
  );
  if (sent >= MAILS_PER_DAY) {
    console.error(`[signup] SIGNUP-DAILY-CAP reached (${MAILS_PER_DAY})`);
    res.status(429).json({ error: 'Sign-up is busy right now — try again tomorrow.' });
    return;
  }

  const existing = await findUser(email);
  if (existing === 'error') {
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return;
  }
  if (existing?.confirmed) {
    res.status(200).json({ status: 'pending' });
    return;
  }
  if (existing && !(await underAddressLimit(supabase, existing.id, res))) return;

  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: publicOrigin(req) },
  });
  if (error) {
    if (error.code === 'email_exists') {
      res.status(200).json({ status: 'pending' });
      return;
    }
    console.error('[signup] generateLink failed:', error.code, error.message);
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return;
  }
  if (!existing && !(await underAddressLimit(supabase, data.user.id, res))) return;

  // The 18+ attestation, on record with the account: when, not just that.
  // app_metadata, not generate_link's `data`: GoTrue applies `data` only when
  // it creates the user (a pending address would keep none), and
  // user_metadata is the user's own to rewrite. Merged by GoTrue, so the
  // provider fields beside it survive. Before the mail: no record, no link.
  const { error: stampErr } = await supabase.auth.admin.updateUserById(data.user.id, {
    app_metadata: { age_confirmed_at: new Date().toISOString() },
  });
  if (stampErr) {
    console.error('[signup] age stamp failed:', stampErr.message);
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return;
  }

  try {
    await sendAccountEmail(confirmationEmail(email, data.properties.action_link));
  } catch (err) {
    console.error('[signup] confirmation email failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'We could not send the email — try again later.' });
    return;
  }
  res.status(200).json({ status: 'pending' });
}

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * Bumps the address's mail counter. False, with the reply already sent, when
 * it is over the limit (answered as success, so the throttle is invisible)
 * or the counter is unreachable (fails closed: unmetered mail is the abuse).
 */
async function underAddressLimit(supabase: Admin, userId: string, res: VercelResponse): Promise<boolean> {
  const { data: count, error } = await supabase.rpc('bump_rate_limit', {
    p_user_id: userId,
    p_bucket: BUCKET,
    p_window_seconds: DAY,
  });
  if (error) {
    console.error('[signup] bump failed:', error.message);
    res.status(500).json({ error: 'Sign-up failed — try again later.' });
    return false;
  }
  if (typeof count === 'number' && count > MAILS_PER_ADDRESS) {
    res.status(200).json({ status: 'pending' });
    return false;
  }
  return true;
}

/**
 * The auth user with exactly this email, null if there is none, 'error' if
 * the lookup failed. GoTrue's admin list takes a `filter` substring match
 * (what Studio's search uses; supabase-js does not expose it), so the exact
 * match is made here.
 */
async function findUser(email: string): Promise<{ id: string; confirmed: boolean } | null | 'error'> {
  const url = optionalEnv('VITE_SUPABASE_URL');
  const key = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return 'error';
  try {
    const reply = await fetch(
      `${url.replace(/\/$/, '')}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) },
    );
    if (!reply.ok) throw new Error(`status ${reply.status}`);
    const body = (await reply.json()) as { users?: { id: string; email?: string; email_confirmed_at?: string | null }[] };
    const user = (body.users ?? []).find(u => u.email?.toLowerCase() === email);
    return user ? { id: user.id, confirmed: Boolean(user.email_confirmed_at) } : null;
  } catch (err) {
    console.error('[signup] user lookup failed:', err instanceof Error ? err.message : err);
    return 'error';
  }
}

async function turnstilePasses(secret: string, token: string, ip: string | null): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const reply = await fetch(SITEVERIFY, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
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
    subject: 'Finish creating your Apex Training account',
    text: `Choose a password to finish creating your Apex Training account:\n\n${link}\n\n`
      + 'If you did not ask for an account, ignore this email — nothing is usable until the link is opened.',
    html: '<p>Choose a password to finish creating your Apex Training account.</p>'
      + `<p><a href="${link}">Set my password</a></p>`
      + '<p>If you did not ask for an account, ignore this email — nothing is usable until the link is opened.</p>',
  };
}
