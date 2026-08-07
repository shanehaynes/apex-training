import { defineConfig } from '@playwright/test';
import type { ApexOptions } from './e2e/lib/fixtures';

// Two projects:
//   mock — vite dev + full request interception; no backend, no writes, safe
//          against any .env.local. The default.
//   live — vite dev:agent against the LOCAL Supabase stack, no interception.
//          Only defined when APEX_LOCAL_SUPABASE=1; the live fixtures refuse
//          any non-localhost backend.
const live = !!process.env.APEX_LOCAL_SUPABASE;

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
    baseURL: 'http://localhost:5173',
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
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});
