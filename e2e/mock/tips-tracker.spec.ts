import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIP_IDS } from '../../src/lib/onboarding/tips/index';

// The tracker's four tips (docs/onboarding/workstreams/O09-tracker.md), each
// at its own site: tracker-shadow / tracker-first on the tracker's first open,
// tracker-unlogged on the unlogged-sets bar, summary-first on the summary.
//
// TipHost shows one card per page load, so each test is its own load with a
// stubbed profile marking every tip seen except the ones it is about — which
// also keeps another feature's tip (the workout modal's, say) from taking
// this load's one card.

test.use({ tips: 'on' });

/** Answer the own-profile read with every tip seen except `unseen`. */
async function onlyUnseen(page: Page, ...unseen: string[]) {
  const seen = Object.fromEntries(
    TIP_IDS.filter(id => !unseen.includes(id)).map(id => [id, '2026-09-01T00:00:00Z']),
  );
  const row = { ...driverProfile(), tips_seen: seen };
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

/** Every tip id the page PATCHes as seen. */
function recordSeen(page: Page): string[] {
  const ids: string[] = [];
  page.on('request', req => {
    if (req.method() !== 'PATCH' || !req.url().includes('/api/profile')) return;
    const body = req.postDataJSON() as { tip_seen?: string };
    if (body.tip_seen) ids.push(body.tip_seen);
  });
  return ids;
}

async function startWorkout(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.getByRole('button', { name: 'Start Workout' }).click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });
}

const tip = (page: Page, id?: string) => page.locator(id ? `.tip[data-tip-id="${id}"]` : '.tip');

test('last time’s numbers on screen: the grey-numbers tip wins the first open', async ({ page }) => {
  await onlyUnseen(page, 'tracker-first', 'tracker-shadow');
  const seen = recordSeen(page);
  await startWorkout(page);
  // The mock bootstrap fabricates history, so shadows are on screen.
  await expect(page.locator('.tracker-input--shadow').first()).toBeVisible();

  const card = tip(page, 'tracker-shadow');
  await expect(card).toBeVisible();
  await expect(tip(page)).toHaveCount(1);
  await expect(card.locator('.tip__link')).toHaveAttribute('href', '/help/logging-a-workout');
  await card.locator('.tip__ok').click();
  await expect(tip(page)).toHaveCount(0);
  await expect.poll(() => seen).toEqual(['tracker-shadow']);

  // One per load: tracker-first is still on offer and unseen, but waits.
  await page.waitForTimeout(1200);
  await expect(tip(page)).toHaveCount(0);
});

test('grey-numbers tip seen: the first-open tip shows instead', async ({ page }) => {
  await onlyUnseen(page, 'tracker-first');
  const seen = recordSeen(page);
  await startWorkout(page);

  const card = tip(page, 'tracker-first');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Finish');
  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => seen).toEqual(['tracker-first']);
});

test('the unlogged bar after Finish offers its tip; the cancel bar does not', async ({ page }) => {
  await onlyUnseen(page, 'tracker-unlogged');
  await startWorkout(page);
  await page.waitForTimeout(1200);
  await expect(tip(page), 'nothing on the tracker once its tips are seen').toHaveCount(0);

  // Same component, different bar: Cancel workout's confirm stays silent.
  await page.getByRole('button', { name: 'Cancel workout' }).click();
  await expect(page.locator('.tracker-confirm')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(tip(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Keep going' }).click();

  // Nothing logged, so Finish raises the unlogged-sets bar.
  await page.locator('.tracker-header__finish').click();
  await expect(page.locator('.tracker-confirm__msg')).toContainText('unlogged');
  const card = tip(page, 'tracker-unlogged');
  await expect(card).toBeVisible();
  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finish anyway' })).toBeVisible();
});

test('the summary’s first appearance explains the trophies', async ({ page }) => {
  await onlyUnseen(page, 'summary-first');
  await startWorkout(page);
  await page.locator('.tracker-header__finish').click();
  await page.getByRole('button', { name: 'Finish anyway' }).click();
  await expect(page.locator('.tracker-summary')).toBeVisible();

  const card = tip(page, 'summary-first');
  await expect(card).toBeVisible();
  await expect(card).toContainText('personal record');
  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.tracker-summary')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the tracker tip clears Finish', async ({ page }) => {
    await onlyUnseen(page, 'tracker-first', 'tracker-shadow');
    await page.goto('/');
    await page.locator('.day-view').getByRole('button', { name: /^Open / }).first().click({ timeout: 20000 });
    await page.getByRole('button', { name: 'Start Workout' }).click();
    const card = tip(page, 'tracker-shadow');
    await expect(card).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(400);

    const cardBox = (await card.boundingBox())!;
    const finishBox = (await page.locator('.tracker-header__finish').boundingBox())!;
    expect(cardBox.y, 'card sits below the header and its Finish button').toBeGreaterThan(finishBox.y + finishBox.height);
    await shot(page, 'tips-tracker-phone');
  });
});
