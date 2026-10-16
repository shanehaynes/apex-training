import { test, expect, apexState, gotoCalendar } from '../lib/fixtures';

// Every REST read a calendar load makes must be answered by the intercept
// layer on the first attempt. A read that escapes to the pinned mock host
// fails at the network level, and a network error or 503/520 makes
// postgrest-js retry a GET 1s/2s/4s, stamping each retry X-Retry-Count — the
// page then sits in isSyncing / "Loading…" for ~7s (#453 for workout_events;
// this spec for the rest).
//
// Not "each URL once": main.tsx mounts under StrictMode, which runs every
// load effect twice in dev, so two is the floor and anything more is a
// retry or a re-fetch.
test('a calendar load answers every Supabase REST read first time', async ({ page }) => {
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

  await gotoCalendar(page);
  // Well inside the 7s retry ladder.
  await expect.poll(
    async () => (await apexState<{ isSyncing: boolean }>(page, 'schedule')).isSyncing,
    { timeout: 3000 },
  ).toBe(false);
  // The first retry lands 1s after its failure; give one the chance to show.
  await page.waitForTimeout(1500);

  expect(failed, 'REST reads that failed at the network level').toEqual([]);
  expect(retried, 'REST reads postgrest-js retried').toEqual([]);
  const overfetched = [...counts].filter(([, n]) => n > 2).map(([url, n]) => `${url} ×${n}`);
  expect(overfetched, 'REST URLs requested more than StrictMode\'s two mounts').toEqual([]);
  expect([...counts.keys()].some(u => u.includes('/rest/v1/workout_events?')), 'workout_events was read').toBe(true);
});
