import { defineConfig } from '@playwright/test';
import type { ApexOptions } from './e2e/lib/fixtures';
import { devPort } from './dev/port.mjs';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { MOCK_SUPABASE } from './e2e/lib/session.mjs';

// Two projects:
//   mock — vite dev + full request interception; no backend, no writes, safe
//          against any .env.local. The default.
//   live — vite dev:agent against the LOCAL Supabase stack, no interception.
//          Only defined when APEX_LOCAL_SUPABASE=1; the live fixtures refuse
//          any non-localhost backend.
const live = !!process.env.APEX_LOCAL_SUPABASE;

// Per-checkout port, the same one vite.config.ts binds (dev/port.mjs). That is
// what makes reuseExistingServer safe below: a server already listening here
// can only be this worktree's, so the suite never tests another session's code.
const port = devPort();

export default defineConfig<ApexOptions>({
  testDir: 'e2e',
  fullyParallel: true,
  // Live specs share ONE local Postgres, and some of them reset whole tables
  // to start pristine. Running their files in parallel workers would race
  // those resets against another file's fixtures, so the live run is
  // single-worker. Mock specs stub every request and stay fully parallel.
  ...(live ? { workers: 1 } : {}),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['./e2e/lib/skipReporter.ts']]
    : [['list'], ['./e2e/lib/skipReporter.ts']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 950 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mock',
      testDir: 'e2e/mock',
      // Pin the app's date-semantic clock: the bundled seed covers
      // 2026-06-22 → 2027-05-31, so an unpinned suite silently expires the
      // day the real clock leaves that range. Specs that need a different
      // date (clock, tracker duration) still override via test.use().
      use: { fakeNow: '2026-09-07T08:00:00' },
    },
    // Live specs read and write rows seeded relative to the REAL clock —
    // no fakeNow here, it would disagree with the seeded data.
    ...(live ? [{ name: 'live', testDir: 'e2e/live' }] : []),
  ],
  webServer: {
    command: live ? 'npm run dev:agent' : 'npm run dev',
    port,
    reuseExistingServer: !process.env.CI,
    // The mock run pins its own fake project so the app is signed-in-capable
    // with or without a .env.local — process VITE_* vars outrank the env
    // files, so this is what the client bundles either way. Without it the
    // suite runs offline wherever .env.local is absent (i.e. CI), and any
    // spec needing the profile fails. Live keeps its real dev:agent env.
    ...(live ? {} : {
      env: {
        ...process.env,
        VITE_SUPABASE_URL: MOCK_SUPABASE.url,
        VITE_SUPABASE_ANON_KEY: MOCK_SUPABASE.anonKey,
      },
    }),
  },
});
