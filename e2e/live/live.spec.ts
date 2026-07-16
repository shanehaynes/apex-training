// Live project: the REAL stack — vite dev:agent (api/* served by the vite
// plugin) + the LOCAL Supabase stack, no request interception. Exercises what
// the mock project cannot: actual sign-in through GoTrue, RLS-scoped reads,
// and /api/* writes landing in Postgres.
//
// Prereqs: supabase start && scripts/db-reset-local.sh
// Run:     npm run e2e:live
//
// SAFETY: refuses to run unless .env.agent points at localhost (enforced by
// localSupabaseEnv). There is no way to aim this at a remote project.

import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../scripts/lib/localEnv.mjs';

// Throws on any non-localhost URL before a single request is made.
const env = localSupabaseEnv();
// Local-stack admin client, for asserting what actually landed in Postgres.
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

// Anchor inside the seeded fixture window (Jul–Sep 2026 one-offs + weekly
// recurring events) so the calendar is populated and renders identically
// on every run.
const FAKE_NOW = '2026-08-03T08:00:00';

async function signIn(page: Page, email: string) {
  await page.addInitScript(v => {
    (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
  }, FAKE_NOW);
  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill('apex-agent-password');
  await page.locator('.auth-submit').click();
}

async function apexState<T = Record<string, unknown>>(page: Page, key: string): Promise<T> {
  return await page.evaluate(
    k => (window as unknown as { __apex?: { state(k?: string): unknown } }).__apex?.state(k),
    key,
  ) as T;
}

// Start pristine regardless of what earlier (possibly interrupted) runs left
// behind: completions and session logs are run artifacts, not fixture data.
test.beforeAll(async () => {
  for (const table of [
    'workout_set_logs', 'workout_cardio_logs', 'workout_sessions',
    'workout_completions', 'workout_completion_log',
  ]) {
    await admin.from(table).delete().gte('event_date', '1900-01-01');
  }
});

test('agent signs in, sees only their seeded data, and a completion write persists', async ({ page }) => {
  await signIn(page, 'agent@apex.local');
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });

  const auth = await apexState<{ status: string; email: string }>(page, 'auth');
  expect(auth.status).toBe('signedIn');
  expect(auth.email).toBe('agent@apex.local');

  const schedule = await apexState<{ eventCount: number }>(page, 'schedule');
  expect(schedule.eventCount, 'seeded events visible under RLS').toBeGreaterThan(0);
  await page.screenshot({ path: 'e2e/screenshots/live-calendar.png' });

  // Toggle a completion through the modal → POST /api/completions through
  // the vite plugin → workout_completions row. Reload and confirm it stuck.
  await page.locator('.event-chip__main').first().click();
  const toggle = page.locator('.modal-completion__btn', { hasText: /Mark as Complete/ });
  await toggle.click();
  await expect(page.locator('.modal-completion__btn--done')).toBeVisible();

  await page.reload();
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
  const after = await apexState<{ completedCount: number }>(page, 'schedule');
  expect(after.completedCount, 'completion persisted server-side').toBeGreaterThan(0);

  // The toggle also quick-completes a session (plan-filled logs) via
  // /api/workout-sessions — its UI errors are swallowed, so assert the rows
  // actually landed in Postgres.
  const { data: sessions } = await admin.from('workout_sessions').select('id,event_id').limit(5);
  expect(sessions?.length, 'quick-complete wrote a workout_sessions row').toBeGreaterThan(0);
  // No cleanup toggle here: beforeAll wipes completion/session artifacts, so
  // every run starts pristine even after an interrupted one.
});

test('agent2 sees an empty calendar (cross-user isolation)', async ({ page }) => {
  await signIn(page, 'agent2@apex.local');
  await expect(page.locator('.top-nav__avatar')).toBeVisible({ timeout: 20000 });

  await page.waitForFunction(() => {
    const s = (window as unknown as { __apex?: { state(k: string): { isEventsLoading: boolean } } })
      .__apex?.state('schedule');
    return s?.isEventsLoading === false;
  });
  const schedule = await apexState<{ eventCount: number }>(page, 'schedule');
  expect(schedule.eventCount, "agent2 must not see agent's events").toBe(0);
});
