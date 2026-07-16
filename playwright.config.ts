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
