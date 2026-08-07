import { defineConfig } from '@playwright/test';

// Two projects:
//   mock — vite dev + full request interception; no backend, no writes, safe
//          against any .env.local. The default.
//   live — vite dev:agent against the LOCAL Supabase stack, no interception.
//          Only defined when APEX_LOCAL_SUPABASE=1; the live fixtures refuse
//          any non-localhost backend.
const live = !!process.env.APEX_LOCAL_SUPABASE;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // Live specs share ONE local Postgres, and some of them reset whole tables
  // to start pristine. Running their files in parallel workers would race
  // those resets against another file's fixtures, so the live run is
  // single-worker. Mock specs stub every request and stay fully parallel.
  ...(live ? { workers: 1 } : {}),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 950 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mock', testDir: 'e2e/mock' },
    ...(live ? [{ name: 'live', testDir: 'e2e/live' }] : []),
  ],
  webServer: {
    command: live ? 'npm run dev:agent' : 'npm run dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});
