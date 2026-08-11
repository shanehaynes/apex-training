import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// COROS sync flow against a scripted /api/provider-sync. The page.route
// installed here outranks the context-level stub in intercept.mjs (which
// answers "not configured" so every other spec keeps its toolbar clean).
// Verifies the decided product behavior: fills need a per-item yes/no,
// unmatched activities import silently, and a declined fill becomes a
// standalone create in the SAME apply call.

const PROPOSALS = [
  {
    activity: {
      activityId: 'a-run', sportLabel: 'Trail Run', apexType: 'cardio',
      localDate: '2026-08-10', displayTime: '6:32 AM', durationMin: 47,
      distance: '5.20 mi', avgHr: 152,
    },
    match: { eventId: 'w1-run', eventDate: '2026-08-10', title: 'Morning Run', startTime: '6:30 AM', type: 'cardio' },
  },
  {
    activity: {
      activityId: 'a-boulder', sportLabel: 'Bouldering', apexType: 'climbing',
      localDate: '2026-08-09', displayTime: '5:15 PM', durationMin: 90,
      distance: null, avgHr: 121,
    },
    match: { eventId: 'w1-climb', eventDate: '2026-08-09', title: 'Gym Session', startTime: '5:30 PM', type: 'climbing' },
  },
  {
    activity: {
      activityId: 'a-bike', sportLabel: 'Bike', apexType: 'cardio',
      localDate: '2026-08-08', displayTime: '7:00 AM', durationMin: 95,
      distance: '18.64 mi', avgHr: 138,
    },
    match: null,
  },
];

test('coros sync: preview, per-fill confirmation queue, one apply', async ({ page }) => {
  let applyBody: { decisions?: Array<Record<string, unknown>> } | null = null;

  await page.route('**/api/provider-sync', async route => {
    const body = route.request().postDataJSON() as { action: string };
    if (body.action === 'status') {
      return route.fulfill({ json: {
        coros: { status: 'connected', lastSyncedAt: null, connectedAt: '2026-08-01T00:00:00Z', configured: true },
      } });
    }
    if (body.action === 'preview') {
      return route.fulfill({ json: { proposals: PROPOSALS } });
    }
    if (body.action === 'apply') {
      applyBody = route.request().postDataJSON();
      return route.fulfill({ json: { created: 2, filled: 1, errors: [] } });
    }
    return route.fulfill({ json: { ok: true } });
  });

  await gotoCalendar(page);

  // Connected → the toolbar shows Sync.
  const syncBtn = page.getByTestId('nav-coros-sync');
  await expect(syncBtn).toBeVisible();
  await syncBtn.click();

  // First fill proposal, with the queue counter.
  const card = page.getByTestId('sync-confirm-card');
  await expect(card).toContainText('Trail Run · 6:32 AM · 5.20 mi — fill planned “Morning Run”?');
  await expect(card).toContainText('1 more after this');
  await shot(page, 'coros-sync-confirm');

  // Accept the run fill → the boulder proposal advances, counter gone.
  await card.getByRole('button', { name: 'Fill it' }).click();
  await expect(card).toContainText('Bouldering · 5:15 PM · 90 min — fill planned “Gym Session”?');
  await expect(card).not.toContainText('more after this');

  // Decline the boulder fill → queue settles → ONE apply carries all three.
  await card.getByRole('button', { name: 'Keep separate' }).click();
  await expect(card).not.toBeVisible();

  await expect.poll(() => applyBody).not.toBeNull();
  expect(applyBody!.decisions).toEqual([
    { activityId: 'a-bike', action: 'create' },
    { activityId: 'a-run', action: 'fill', targetEventId: 'w1-run', eventDate: '2026-08-10' },
    { activityId: 'a-boulder', action: 'create' },
  ]);

  // Summary toast, and the button is usable again.
  await expect(page.getByText('COROS: Imported 2 activities · filled 1 planned workout')).toBeVisible();
  await expect(syncBtn).toBeEnabled();
});
