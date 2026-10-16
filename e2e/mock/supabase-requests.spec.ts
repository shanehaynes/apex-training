import { test, expect, apexState, gotoCalendar } from '../lib/fixtures';
import type { Page } from '@playwright/test';

// Every REST read a load makes must be answered by the intercept layer on
// the first attempt. A read that escapes to the pinned mock host fails at the
// network level, and a network error or 503/520 makes postgrest-js retry a
// GET 1s/2s/4s, stamping each retry X-Retry-Count — the page then sits in
// isSyncing / "Loading…" for ~7s (#453 for workout_events, #454 for
// completions and sessions).
//
// Not "each URL once": main.tsx mounts under StrictMode, which runs every
// load effect twice in dev, so two is the floor and anything more is a
// retry or a re-fetch.

function recordRest(page: Page) {
  const isRest = (url: string) => /^https:\/\/[^/]+\.supabase\.co\/rest\/v1\//.test(url);
  const counts = new Map<string, number>();
  const retried: string[] = [];
  const failed: string[] = [];
  page.on('request', req => {
    if (!isRest(req.url()) || req.method() !== 'GET') return;
    counts.set(req.url(), (counts.get(req.url()) ?? 0) + 1);
    const retry = req.headers()['x-retry-count'];
    if (retry) retried.push(`${req.url()} (retry ${retry})`);
  });
  page.on('requestfailed', req => {
    if (isRest(req.url())) failed.push(`${req.url()} — ${req.failure()?.errorText}`);
  });
  return {
    read: (table: string, filter = '') =>
      [...counts.keys()].some(u => u.includes(`/rest/v1/${table}?`) && u.includes(filter)),
    async expectClean() {
      // The first retry lands 1s after its failure; give one the chance to show.
      await page.waitForTimeout(1500);
      expect(failed, 'REST reads that failed at the network level').toEqual([]);
      expect(retried, 'REST reads postgrest-js retried').toEqual([]);
      const overfetched = [...counts].filter(([, n]) => n > 2).map(([url, n]) => `${url} ×${n}`);
      expect(overfetched, 'REST URLs requested more than StrictMode\'s two mounts').toEqual([]);
    },
  };
}

test('a calendar load answers every Supabase REST read first time', async ({ page }) => {
  const rest = recordRest(page);
  await gotoCalendar(page);
  // Well inside the 7s retry ladder.
  await expect.poll(
    async () => (await apexState<{ isSyncing: boolean }>(page, 'schedule')).isSyncing,
    { timeout: 3000 },
  ).toBe(false);
  await rest.expectClean();
  expect(rest.read('workout_events'), 'workout_events was read').toBe(true);
  expect(rest.read('workout_completions'), 'workout_completions was read').toBe(true);
});

test('block detail answers its progress reads first time', async ({ page }) => {
  // training_blocks stubs empty by default, so no block detail — and none of
  // its reads — happen without one. The mock clock is 2026-09-07.
  await page.route(/rest\/v1\/training_blocks/, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'blk-base', user_id: 'mock-user', objective_id: null, name: 'Base', intent: 'Aerobic foundation.',
      phase: 'base', start_date: '2026-09-07', end_date_exclusive: '2026-10-05',
      weekly_targets: { cardio_minutes: 300 }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    }]),
  }));
  const rest = recordRest(page);
  await page.goto('/');
  await expect(page.locator('.top-nav')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('nav-blocks').click();
  await page.locator('.block-row', { hasText: 'Base' }).click();
  // "Loading…" until completions and sessions settle — inside the retry ladder.
  await expect(page.getByText(/of 4 weeks complete/)).toBeVisible({ timeout: 3000 });
  await rest.expectClean();
  const blockWindow = 'event_date=gte.2026-09-07';
  expect(rest.read('workout_completions', blockWindow), 'block completions were read').toBe(true);
  expect(rest.read('workout_sessions', blockWindow), 'block sessions were read').toBe(true);
});
