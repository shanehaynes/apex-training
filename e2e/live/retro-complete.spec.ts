// Live coverage for retro-logging: an event composed onto a day that has
// already passed auto-completes on creation — locally, in
// workout_completions, and as a plan-filled quick session. Since #136 that
// whole sequence is one POST /api/workout-draft, so this is also the live
// end-to-end proof of the builder's Apply.

import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../scripts/lib/localEnv.mjs';

const env = localSupabaseEnv();
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

const FAKE_NOW = '2026-08-03T08:00:00';
const TITLE = 'Retro Log Spec';

async function signIn(page: Page, email: string) {
  await page.addInitScript(v => {
    (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
  }, FAKE_NOW);
  // Onboarding tips stay off in the live suite too: a tip card's backdrop
  // would swallow the next click (the mock specs get this from fixtures.ts).
  await page.addInitScript(() => {
    (window as unknown as { __APEX_TIPS_OFF__?: boolean }).__APEX_TIPS_OFF__ = true;
  });
  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill('apex-agent-password');
  await page.locator('.auth-submit').click();
}

// This spec's artifacts are keyed by TITLE, not blanket-wiped: live specs run
// fully parallel, so table-wide deletes here could race the other live file.
async function deleteArtifacts() {
  const { data } = await admin.from('workout_events').select('id').eq('title', TITLE);
  for (const row of data ?? []) {
    for (const table of ['workout_set_logs', 'workout_sessions', 'workout_completions', 'workout_completion_log']) {
      await admin.from(table).delete().eq('event_id', row.id);
    }
    await admin.from('workout_events').delete().eq('id', row.id);
  }
  // Apply also upserts the library template for the title.
  await admin.from('workout_templates').delete().eq('title', TITLE);
}

test.beforeAll(deleteArtifacts);
test.afterAll(deleteArtifacts);

test('an event added to a past day is completed on creation', async ({ page }) => {
  await signIn(page, 'agent@apex.local');
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });

  // Compose onto Aug 1 — two days before the frozen "today" (Aug 3).
  await page.locator('button[aria-label="View August 1"]').click();
  await page.locator('.day-modal__add', { hasText: 'Add event' }).click();
  await page.locator('.builder-search__create').click();
  await expect(
    page.locator('.library-field', { hasText: 'Date' }).locator('input'),
    'builder inherits the clicked past day',
  ).toHaveValue('2026-08-01');
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill(TITLE);
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  // Server-side first: the completion row and the quick session are
  // fire-and-forget writes, so let them land before the reload below can
  // abort them mid-flight.
  const { data: events } = await admin.from('workout_events').select('id').eq('title', TITLE);
  expect(events?.length, 'exactly one created event row').toBe(1);
  const eventId = events![0].id as string;

  await expect.poll(async () => {
    const { data } = await admin.from('workout_completions').select('is_completed').eq('event_id', eventId);
    return data?.[0]?.is_completed ?? null;
  }, { timeout: 15000 }).toBe(true);

  await expect.poll(async () => {
    const { data } = await admin.from('workout_sessions').select('id').eq('event_id', eventId);
    return data?.length ?? 0;
  }, { timeout: 15000 }).toBeGreaterThan(0);

  // Apply places the created event locally, but reload anyway: that is what
  // proves the row and its completed state come back from the SERVER
  // (workout_events + workout_completions) rather than from local state —
  // the local stack has no realtime publication to reconcile the two.
  await page.reload();
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(t => {
    const s = (window as unknown as {
      __apex?: { state(k: string): { events: { title: string; date: string; isCompleted: boolean }[] } };
    }).__apex?.state('schedule');
    return s?.events.some(e => e.title === t && e.date === '2026-08-01' && e.isCompleted);
  }, TITLE, { timeout: 20000 });
  await page.screenshot({ path: 'e2e/screenshots/live-retro-complete.png' });
});
