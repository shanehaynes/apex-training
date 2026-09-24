import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIPS } from '../../src/lib/onboarding/tips/index';
import { BLOCKS_ANALYTICS_TIPS } from '../../src/lib/onboarding/tips/blocks-analytics';
import { draftFromSpec } from '../../src/lib/analytics/draft';
import type { ChartSpec } from '../../src/lib/analytics/spec';

// The blocks + analytics tips (docs/onboarding/workstreams/O13-blocks-analytics.md):
// the first open of Training blocks, of Analytics, and of the tile builder for
// a NEW tile each offer one card. TipHost shows one per page load, so every
// test marks the rest of the catalog seen on the server — only the tip under
// test can win, whatever other lanes' useTip calls the calendar makes.

test.use({ tips: 'on' });

const tip = (id: (typeof BLOCKS_ANALYTICS_TIPS)[number]['id']) =>
  BLOCKS_ANALYTICS_TIPS.find(t => t.id === id)!;

/** Serve the own-profile row with every tip seen except `unseen`. */
async function onlyUnseen(page: Page, ...unseen: string[]) {
  const seen = Object.fromEntries(
    TIPS.filter(t => !unseen.includes(t.id)).map(t => [t.id, '2026-09-01T00:00:00Z']),
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

/** Every tip_seen the page PATCHes to /api/profile. */
function recordSeen(page: Page): string[] {
  const ids: string[] = [];
  page.on('request', req => {
    if (req.method() !== 'PATCH' || !req.url().includes('/api/profile')) return;
    const body = req.postDataJSON() as { tip_seen?: string };
    if (body.tip_seen) ids.push(body.tip_seen);
  });
  return ids;
}

/** Long enough for TipHost's 600 ms settle to have come and gone. */
const PAST_SETTLE_MS = 1200;

const MILEAGE_SPEC: ChartSpec = {
  version: 1,
  title: 'Weekly mileage',
  chartType: 'line',
  range: { kind: 'rolling', days: 90 },
  bucket: 'week',
  series: [{ id: 's1', measure: 'distance' }],
};

/** One saved tile from the GET, so there is something to edit. */
async function stubSavedTile(page: Page) {
  await page.route('**/api/analytics-tiles', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tiles: [{
          id: 'tile-mileage',
          title: MILEAGE_SPEC.title,
          spec: MILEAGE_SPEC,
          draft: draftFromSpec(MILEAGE_SPEC),
          layout: { x: 0, y: 0, w: 6, h: 4 },
          updatedAt: '2026-09-01T00:00:00Z',
        }],
        options: { categories: [], otherWorkoutTitles: [] },
      }),
    });
  });
}

test('Training blocks: the first open explains a block and names New cycle', async ({ page }) => {
  await onlyUnseen(page, 'blocks-first');
  const seen = recordSeen(page);
  await gotoCalendar(page);
  await page.waitForTimeout(PAST_SETTLE_MS);
  await expect(page.locator('.tip'), 'nothing on the calendar').toHaveCount(0);

  await page.getByTestId('nav-blocks').click();
  await expect(page.locator('.library-header__title')).toHaveText('Training blocks');

  const card = page.locator('.tip[data-tip-id="blocks-first"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(tip('blocks-first').title);
  // The bold label is the button on screen behind the card.
  await expect(card.locator('.tip__text strong')).toHaveText('New cycle');
  await expect(page.getByTestId('new-cycle')).toHaveText('New cycle');
  await shot(page, 'tips-blocks-first');

  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => seen).toEqual(['blocks-first']);
});

test('Analytics: the first open explains a tile and names New tile', async ({ page }) => {
  await onlyUnseen(page, 'analytics-first');
  const seen = recordSeen(page);
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await expect(page.getByTestId('analytics-view')).toBeVisible();

  const card = page.locator('.tip[data-tip-id="analytics-first"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(tip('analytics-first').title);
  await expect(card.locator('.tip__text strong')).toHaveText('New tile');
  await expect(page.getByTestId('analytics-new-tile')).toHaveText('New tile');
  await shot(page, 'tips-analytics-first');

  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => seen).toEqual(['analytics-first']);
});

test('one per load: after the Analytics tip, a new tile brings no second card', async ({ page }) => {
  await onlyUnseen(page, 'analytics-first', 'tile-builder-first');
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  const card = page.locator('.tip');
  await expect(card).toHaveAttribute('data-tip-id', 'analytics-first');
  await card.locator('.tip__ok').click();

  await page.getByTestId('analytics-new-tile').click();
  await expect(page.locator('.tile-builder')).toBeVisible();
  await page.waitForTimeout(PAST_SETTLE_MS);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('tile builder: a new tile, once Analytics is seen, gets its own card', async ({ page }) => {
  await onlyUnseen(page, 'tile-builder-first');
  const seen = recordSeen(page);
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await expect(page.getByTestId('analytics-view')).toBeVisible();
  await page.waitForTimeout(PAST_SETTLE_MS);
  await expect(page.locator('.tip'), 'the dashboard tip is already seen').toHaveCount(0);

  await page.getByTestId('analytics-new-tile').click();
  await expect(page.locator('.tile-builder__heading')).toHaveText('New tile');

  // Nothing in the builder takes focus by itself, so the card lands on open.
  const card = page.locator('.tip[data-tip-id="tile-builder-first"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(tip('tile-builder-first').title);
  await expect(card.locator('.tip__text strong')).toHaveText(['Measure', 'Preview', 'Save tile']);
  // Every bold label is a label the builder actually shows.
  await expect(page.locator('.an-field__label', { hasText: /^Measure$/ })).toHaveCount(1);
  await expect(page.locator('.tile-builder__preview > .an-field__label')).toHaveText('Preview');
  await expect(page.getByTestId('tile-save')).toHaveText('Save tile');
  await shot(page, 'tips-tile-builder-first');

  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => seen).toEqual(['tile-builder-first']);
});

test('tile builder: editing a saved tile offers nothing', async ({ page }) => {
  await onlyUnseen(page, 'tile-builder-first');
  await stubSavedTile(page);
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await page.locator('.tile-card__menu-btn').click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.locator('.tile-builder__heading')).toHaveText('Edit tile');
  await page.waitForTimeout(PAST_SETTLE_MS);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('tile builder: a user already typing holds the card until they leave the field', async ({ page }) => {
  await onlyUnseen(page, 'tile-builder-first');
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await page.getByTestId('analytics-new-tile').click();
  // Inside the settle window: focus a field before the card can land.
  await page.getByTestId('tile-title').focus();
  await page.waitForTimeout(PAST_SETTLE_MS);
  await expect(page.locator('.tip'), 'held while the title has focus').toHaveCount(0);

  await page.getByTestId('tile-title').blur();
  await expect(page.locator('.tip[data-tip-id="tile-builder-first"]')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the Analytics tab offers the dashboard tip', async ({ page }) => {
    await onlyUnseen(page, 'analytics-first');
    await page.goto('/');
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('mobile-nav-analytics').click();
    await expect(page.getByTestId('analytics-view')).toBeVisible();

    const card = page.locator('.tip[data-tip-id="analytics-first"]');
    await expect(card).toBeVisible();
    await shot(page, 'tips-analytics-first-phone');
    await card.locator('.tip__ok').click();
    await expect(card).toHaveCount(0);
  });
});
