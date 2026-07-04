---
name: project-supabase-vercel
description: Supabase + Vercel env var setup required for cross-device completion sync
metadata:
  type: project
---

Supabase sync works and is live in production as of 2026-06-27.

**Why:** Vite only exposes env vars prefixed with `VITE_` to the client bundle. Vercel had the Supabase credentials under `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_URL`, which were invisible at runtime — causing the app to fall back to localStorage-only mode.

**Fixed by:** Adding `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to Vercel environment variables (kept old names too). Local `.env.local` also had an invalid anon key (`sb_secret_...` format instead of a JWT).

**How to apply:** If sync ever breaks again, check: (1) `.env.local` has a valid JWT for `VITE_SUPABASE_ANON_KEY`, (2) Vercel has both `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set, (3) a redeploy was triggered after any env var changes.

Tables (`workout_completions`, `workout_completion_log`) were already created in Supabase via `supabase/schema.sql`. RLS is disabled (single-user, no auth).
