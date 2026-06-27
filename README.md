# Apex Training

A personal training calendar and workout tracker. View your schedule by day, week, or month, and mark workouts as completed — state syncs across devices via Supabase.

## Stack

- **React + TypeScript** — UI
- **Vite** — build tool
- **Supabase** — Postgres backend for cross-device completion sync
- **Vercel** — hosting

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

```env
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...   # anon/public key from Supabase Settings → API
```

### 3. Create the database tables

Run [`supabase/schema.sql`](supabase/schema.sql) in your Supabase project's SQL editor. This creates:

- `workout_completions` — current completion state (upserted on each toggle)
- `workout_completion_log` — append-only history of every toggle

### 4. Run locally

```bash
npm run dev
```

## Deployment (Vercel)

Set the following environment variables in your Vercel project under **Settings → Environment Variables**:

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | your Supabase anon/public JWT |

> **Note:** Vite only exposes variables prefixed with `VITE_` to the client bundle. Variables named `NEXT_PUBLIC_*` or without a prefix will be ignored.

After adding or changing env vars, trigger a redeploy for them to take effect.

## Offline / fallback

If Supabase credentials are missing or the request fails, the app falls back to `localStorage` automatically. Completions will persist locally but won't sync across devices.
