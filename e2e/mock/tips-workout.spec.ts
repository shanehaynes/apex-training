import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';

// The workout modal's first-open tips (docs/onboarding/workstreams/
// O08-workout-detail.md): a repeating workout explains what changes one day
// versus the series, a one-off explains the buttons, and a workout with watch
// numbers explains where they came from. TipHost's rules (one per load, seen
// once per account) are tips-core.spec.ts's job; this spec proves the
// trigger sites and which tip wins at each.

test.use({ tips: 'on' });

// Mock clock 2026-09-07. The seed's Tuesday weights session repeats weekly;
// the nightly stretches are one-offs.
const RECURRING = 'Weights — Session A';
const ONE_OFF = 'Nightly Stretch';

/** Every PATCH /api/profile body the page sends, answered { ok: true }. */
async function recordTipPatches(page: Page): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/profile', route => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.fallback();
    bodies.push(req.postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify({ ok: true }),
    });
  });
  return bodies;
}

/** Answer the own-profile read with these tips already seen. */
async function seenOnServer(page: Page, ids: string[]) {
  const row = { ...driverProfile(), tips_seen: Object.fromEntries(ids.map(id => [id, '2026-09-01T00:00:00Z'])) };
  await page.route(/\.supabase\.co\/rest\/v1\/profiles/, route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify(wantsObject ? row : [row]),
    });
  });
}

async function open(page: Page, title: string) {
  await page.locator('.event-chip__main', { hasText: title }).first().click();
  await expect(page.getByRole('dialog', { name: new RegExp(title) })).toBeVisible();
}

const tip = (page: Page, id: string) => page.locator(`.tip[data-tip-id="${id}"]`);

test('a repeating workout shows the repeat tip, not the first-open one', async ({ page }) => {
  await gotoCalendar(page);
  await open(page, RECURRING);

  await expect(tip(page, 'workout-recurring')).toBeVisible();
  await expect(tip(page, 'workout-recurring')).toContainText('Edit exercises');
  await expect(page.locator('.tip')).toHaveCount(1);
  await expect(tip(page, 'workout-first-open')).toHaveCount(0);
});

test('a one-off workout on a fresh load shows the first-open tip', async ({ page }) => {
  await gotoCalendar(page);
  await open(page, ONE_OFF);

  await expect(tip(page, 'workout-first-open')).toBeVisible();
  await expect(tip(page, 'workout-first-open')).toContainText('Start Workout');
  await expect(tip(page, 'workout-recurring')).toHaveCount(0);
});

test('Got it is remembered: the repeat tip does not come back after a reload', async ({ page }) => {
  const patches = await recordTipPatches(page);
  await gotoCalendar(page);
  await open(page, RECURRING);

  await tip(page, 'workout-recurring').locator('.tip__ok').click();
  await expect(page.locator('.tip')).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: 'workout-recurring' });
  // The modal the tip sat on is still there.
  await expect(page.getByRole('dialog', { name: new RegExp(RECURRING) })).toBeVisible();

  // The server stub still answers tips_seen: {} — the device's mirror is
  // what carries the dismissal, as it does in prod before the column lands.
  await page.reload();
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
  await open(page, RECURRING);
  // The same workout now falls through to the next unseen tip.
  await expect(tip(page, 'workout-first-open')).toBeVisible();
  await expect(tip(page, 'workout-recurring')).toHaveCount(0);
});

test('Show me how opens the repeating-workouts help page in a new tab', async ({ page, context }) => {
  const patches = await recordTipPatches(page);
  await gotoCalendar(page);
  await open(page, RECURRING);

  const link = tip(page, 'workout-recurring').locator('.tip__link');
  await expect(link).toHaveAttribute('target', '_blank');
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).pathname).toBe('/help/repeating-workouts');
  await expect(popup.locator('h1')).toHaveText('Workouts that repeat');
  await popup.close();

  await expect(page.locator('.tip')).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: 'workout-recurring' });
});

test('watch numbers show the sync-metrics tip once the workout tips are seen', async ({ page }) => {
  // Both P0 workout tips are seen, so the P1 one is the only candidate left.
  await seenOnServer(page, ['workout-first-open', 'workout-recurring']);
  // One streams row, for any event: SyncMetrics renders when a row exists.
  await page.route(/\.supabase\.co\/rest\/v1\/activity_streams/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    body: JSON.stringify({
      provider: 'coros',
      summary: { avgHr: 132, maxHr: 168, calories: 410, trainingLoad: 58 },
      streams: null,
    }),
  }));
  await gotoCalendar(page);
  await open(page, ONE_OFF);

  await expect(page.getByTestId('sync-metrics')).toBeVisible();
  await expect(tip(page, 'workout-sync-metrics')).toBeVisible();
  await expect(tip(page, 'workout-sync-metrics').locator('.tip__link')).toHaveAttribute('href', '/help/connect-coros');
});

test('no watch numbers, no sync-metrics tip', async ({ page }) => {
  await seenOnServer(page, ['workout-first-open', 'workout-recurring']);
  await gotoCalendar(page);
  await open(page, ONE_OFF);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('sync-metrics')).toHaveCount(0);
  await expect(page.locator('.tip')).toHaveCount(0);
});
