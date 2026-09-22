import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
import { draftFromSpec } from '../../src/lib/analytics/draft';
import type { ChartSpec } from '../../src/lib/analytics/spec';

// The analytics dashboard (phase 35): empty state → tile builder → live
// preview → save (intercepted POST) → tile in the grid. Since #152 every one
// of those steps is an API call: the tiles GET, the compute POST behind the
// preview, and a save whose body is the builder's DRAFT — the browser builds
// no spec and aggregates no rows. The mock backend answers all three from a
// fabricated history (e2e/lib/mock/analytics.mjs) using the app's own
// specFromDraft/computeTile, so a refusal asserted here is the real text.
// Saved-tile scenarios stub the GET; the clock is pinned to 2026-09-07, so a
// rolling 90-day range lands on top of that history.

const MILEAGE_SPEC: ChartSpec = {
  version: 1,
  title: 'Weekly mileage',
  chartType: 'line',
  range: { kind: 'rolling', days: 90 },
  bucket: 'week',
  series: [{ id: 's1', measure: 'distance' }],
};

/** One saved tile, in the shape GET /api/analytics-tiles serves. */
const MILEAGE_TILE = {
  id: 'tile-mileage',
  title: MILEAGE_SPEC.title,
  spec: MILEAGE_SPEC,
  draft: draftFromSpec(MILEAGE_SPEC),
  layout: { x: 0, y: 0, w: 6, h: 4 },
  updatedAt: '2026-09-01T00:00:00Z',
};

/** Serve one saved tile from the GET, leaving every other call to the mock layer. */
async function stubSavedTile(page: import('@playwright/test').Page) {
  await page.route('**/api/analytics-tiles', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tiles: [MILEAGE_TILE],
        options: { categories: ['strength'], otherWorkoutTitles: ['Soccer night'] },
      }),
    });
  });
}

/**
 * Capture saves without answering them. The load-time GET now hits the same
 * URL, so the handler filters on method and hands everything back to the
 * intercept layer, which actually stores the tile and replies.
 */
async function captureSaves(page: import('@playwright/test').Page) {
  const posted: Array<Record<string, unknown>> = [];
  await page.route('**/api/analytics-tiles', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fallback();
  });
  return posted;
}

test('empty dashboard explains itself and the builder saves a tile', async ({ page }) => {
  const posted = await captureSaves(page);

  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await expect(page.getByTestId('analytics-view')).toBeVisible();
  await expect(page.getByTestId('analytics-empty')).toContainText('New tile');
  await shot(page, 'analytics-empty');

  await page.getByTestId('analytics-new-tile').click();
  await page.getByTestId('tile-title').fill('Training sessions');

  // Pick a measure; the preview is the server computing the same draft Save
  // is about to persist.
  await page.getByRole('radio', { name: 'Sessions', exact: true }).click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  // A line chart over the fabricated history draws its axes as SVG.
  await expect(page.getByTestId('tile-preview').locator('svg')).toBeVisible();
  await shot(page, 'analytics-builder');

  await page.getByTestId('tile-save').click();

  // The wire payload is the whole contract, and it is the DRAFT — no spec is
  // built in the browser any more, and the layout is its own object.
  await expect(page.locator('.tile-card__title')).toHaveText('Training sessions');
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    draft: {
      title: 'Training sessions',
      chartType: 'line',
      rangeKind: 'rolling',
      bucket: 'week',
      series: [{ id: 's1', measure: 'session-count' }],
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  });
  expect(posted[0].spec, 'the web no longer sends a spec').toBeUndefined();
  expect(String(posted[0].id)).toMatch(/^tile-/);

  // The tile the SERVER answered with is what the grid holds.
  await expect(page.getByTestId('analytics-empty')).toBeHidden();
  const state = await apexState<{ tiles: Array<{ title: string; measures: string[] }> }>(page, 'analytics');
  expect(state.tiles).toHaveLength(1);
  expect(state.tiles[0].measures).toEqual(['session-count']);
  await shot(page, 'analytics-grid');
});

test('a saved tile renders and edits round-trip through the builder', async ({ page }) => {
  await stubSavedTile(page);

  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await expect(page.locator('.tile-card__title')).toHaveText('Weekly mileage');
  // Computed by the server and handed to the card — the loading state gives
  // way to the chart only once the result lands. Scoped to the body: the
  // header's kebab is an svg too.
  await expect(page.getByTestId('tile-tile-mileage').locator('.tile-card__body svg')).toBeVisible();
  // The axis ink is read from tokens.css at render, never pasted: the tick's
  // fill must equal whatever --text-muted computes to on this page.
  const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim());
  expect(ink).toMatch(/^#[0-9a-f]{6}$/);
  await expect(page.getByTestId('tile-tile-mileage').locator('.recharts-cartesian-axis-tick-value').first()).toHaveAttribute('fill', ink);

  // Edit opens the builder prefilled from the draft the GET carried.
  await page.locator('.tile-card__menu-btn').click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByTestId('tile-title')).toHaveValue('Weekly mileage');
  await expect(page.getByRole('radio', { name: 'Distance', exact: true })).toHaveAttribute('aria-checked', 'true');

  // Back returns to the grid without saving.
  await page.locator('.library-back').click();
  await expect(page.locator('.tile-card__title')).toHaveText('Weekly mileage');
});

test('an invalid draft explains itself instead of previewing', async ({ page }) => {
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await page.getByTestId('analytics-new-tile').click();

  // Max grade without a scale is the canonical draft-level violation, and the
  // text under the form is now the server's own chartDraftProblem answer.
  await page.getByRole('radio', { name: 'Max grade', exact: true }).click();
  await expect(page.getByTestId('tile-builder-problem')).toContainText('grade scale');

  await page.getByRole('radio', { name: 'YDS', exact: true }).click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
});

test('a blank title is refused by the server and the builder stays open', async ({ page }) => {
  const posted = await captureSaves(page);

  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await page.getByTestId('analytics-new-tile').click();

  // A valid draft in every other respect: the server checks the title first,
  // which is the opposite of the order the web used to apply.
  await page.getByRole('radio', { name: 'Sessions', exact: true }).click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  await page.getByTestId('tile-save').click();

  await expect(page.getByText('Give the tile a title').first()).toBeVisible();
  await expect(page.getByTestId('tile-save-problem')).toContainText('Give the tile a title');
  // Still in the builder, with the work intact.
  await expect(page.getByTestId('tile-title')).toBeVisible();
  await expect(page.getByTestId('analytics-empty')).toHaveCount(0);
  expect(posted, 'one save attempt, not one per refusal').toHaveLength(1);
});

test('incompatible sport/measure pairings dim instead of erroring', async ({ page }) => {
  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await page.getByTestId('analytics-new-tile').click();

  // Distance chosen first → the climbing sport chip dims and won't toggle.
  await page.getByRole('radio', { name: 'Distance', exact: true }).click();
  await page.getByRole('button', { name: /Filters/ }).click();
  const climbingChip = page.locator('.an-chips[aria-label="Sports"] .an-chip', { hasText: 'Climbing' });
  await expect(climbingChip).toHaveClass(/an-chip--dimmed/);
  // force: Playwright blocks normal clicks on aria-disabled elements — the
  // point is that even a landed click changes nothing.
  await climbingChip.click({ force: true });
  await expect(climbingChip).toHaveAttribute('aria-pressed', 'false');

  // The mirror: a running filter chosen first dims the climbing measures.
  await page.locator('.an-chips[aria-label="Sports"] .an-chip', { hasText: 'Running' }).click();
  await expect(page.getByRole('radio', { name: 'Pitches', exact: true })).toHaveClass(/an-chip--dimmed/);
  await expect(page.getByRole('radio', { name: 'Max grade', exact: true })).toHaveClass(/an-chip--dimmed/);
  await shot(page, 'analytics-dimming');
});

test('mobile: the analytics button opens the dashboard as a stacked list', async ({ page }) => {
  await stubSavedTile(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await page.locator('.mobile-nav').waitFor({ state: 'visible', timeout: 20000 });

  // Tab order holds: Calendar, Coach (the renamed sidebar tab), Analytics.
  await expect(page.locator('.mobile-nav__tab').nth(1)).toContainText('Coach');
  await page.getByTestId('mobile-nav-analytics').click();
  await expect(page.getByTestId('analytics-view')).toBeVisible();
  await expect(page.locator('.analytics-stack .tile-card__title')).toHaveText('Weekly mileage');
  await shot(page, 'analytics-mobile');
});
