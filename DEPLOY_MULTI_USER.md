# Multi-User Rollout Runbook

Ordered steps to take Apex Training from single-user to multi-user. The code
in this repo is ready; these are the Supabase-dashboard and Vercel steps only
you can do. **Order matters** — each phase keeps the app working for you
throughout.

## 1. Dashboard prep (before anything else)

1. Supabase Dashboard → Authentication → Users → **Add user**:
   `shanehaynes.sah@gmail.com`, set a password, check **Auto Confirm User**.
   (phase9 aborts if this user doesn't exist — it backfills all existing data
   to your account by this email.)
2. Authentication → Sign In / Up: turn **off** "Allow new users to sign up"
   (invite-only; email+password sign-in keeps working).
3. Authentication → URL Configuration. **Read this twice — it is the one step
   that has actually gone wrong.** "Your production Vercel URL" is ambiguous,
   and the wrong reading breaks every invite you will ever send:
   - **Site URL:** `https://apextrainingcalendar.vercel.app` — the public
     custom domain. **Not** `apex-training-<something>.vercel.app`. Those are
     Vercel's generated project aliases, they sit behind Deployment Protection,
     and every mailed link is built from Site URL — so an invitee clicking one
     gets Vercel's login page demanding they create a *Vercel* account, and
     never reaches Apex at all.
   - **Redirect URLs:** `https://apextrainingcalendar.vercel.app/**`,
     `http://localhost:5173/**`, and `http://localhost:*/**` (worktree dev
     ports from `dev/port.mjs`). The production domain must be here as well as
     in Site URL: anything the app passes as `redirect_to` and that is not on
     this list is *silently* swapped for Site URL, with no error anywhere —
     which is how "Forgot password?" can break in production while invites
     look fine. Do not add preview domains; previews are SSO-walled by design.

   Prove it, rather than trusting the form:

   ```bash
   scripts/auth-redirect-check.sh
   ```
4. Copy your new auth user's UUID (Users list → click the row). In Vercel →
   Project → Settings → Environment Variables, add
   `SEED_SOURCE_USER_ID=<that uuid>` (all environments). Add it to
   `.env.local` too.

## 2. Run phase9 (non-breaking)

SQL Editor → paste `supabase/migrations/phase9_multi_user.sql` → run.

Everything existing is assigned to your account, with a temporary
`DEFAULT <your uid>` on `user_id` so the currently-deployed (pre-auth) code
keeps writing correctly as you. Verify the live site still works exactly as
before.

## 3. Deploy the code in this repo

`git push` → Vercel deploy. Then sign in as yourself. Verify:

- Login persists across reloads (close the tab, reopen — still signed in).
- Your calendar, tracker, library, and coach all behave as before.
- The avatar button shows left of APEX; the profile page opens; password
  change works; the ICS URL in the profile loads in a browser.

## 4. Run phase10 (lockdown) — only after step 3 is confirmed

SQL Editor → `supabase/migrations/phase10_rls_lockdown.sql` → run.

Drops the temporary defaults and every anon read-all policy. Sanity check:
an incognito window on the site shows the login screen, and the old
`/api/calendar-feed` URL **without** a token now returns 401 (update your
calendar subscription to the tokened URL from your profile page).

## 5. Invite the others

Run `scripts/auth-redirect-check.sh` first — a green check here is what makes
the rest of this section true, and step 1.3 is easy to get wrong.

Authentication → Users → **Invite user** (one at a time; built-in SMTP is
rate-limited to a few emails per hour). Each invitee:

1. Clicks the email link → lands on the set-password screen.
2. Gets a random animal avatar automatically.
3. Sees the "Copy Shane's recurring workouts" banner — one click copies your
   recurring events + the exercises they reference. It's one-time and safe to
   double-click.

Password managers (iCloud Keychain / Google) will offer to save the password
at set-password time — that's what enables Face ID / Touch ID sign-in later.

## Phase 11 — Per-user Anthropic API keys

The coach chat and post-workout summaries now run on each user's own
Anthropic key instead of the shared server key.

1. SQL Editor → run `supabase/migrations/phase11_user_api_keys.sql`
   (safe to run before the deploy — nothing reads the table yet).
2. Deploy the code.
3. **Breaking step: the coach is down for EVERY user — you included —
   until each person saves a key** via Profile (circle avatar) → AI Coach.
   Keys come from console.anthropic.com → Settings → API keys; they're
   verified against Anthropic on save and stored server-side (the browser
   only ever sees the last 4 characters).
4. After your key works, delete `ANTHROPIC_API_KEY` (and any legacy
   `VITE_ANTHROPIC_API_KEY`) from Vercel → Settings → Environment
   Variables — nothing reads them anymore.

## Notes

- **Free tier**: 5 users is nowhere near any limit (500 MB DB / 50K MAU).
  The one real caveat: free projects **pause after ~7 days with no traffic**
  and need a manual restore in the dashboard. Regular use prevents it.
- **Password reset**: "Forgot password?" on the login screen emails a
  recovery link; it lands on the same set-password screen. Links are
  single-use and expire in ~24h. The link is built from `redirectTo:
  publicOrigin()`, so it depends on the same allow-list as step 1.3.
- **Links already sent** are baked with whatever Site URL was current when
  they were mailed. Fixing step 1.3 does not repair an email already in
  someone's inbox — delete the invited user and invite again. (The token
  itself is unspent, so appending
  `&redirect_to=https://apextrainingcalendar.vercel.app` to the
  `…/auth/v1/verify?token=…` URL also works, once the allow-list is right.)
- Delete this file once the rollout is done.
