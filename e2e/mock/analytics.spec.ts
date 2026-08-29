import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

// The analytics dashboard (phase 35): empty state → tile builder → live
// preview → save (intercepted POST) → tile in the grid. The mock backend
// serves empty analytics_tiles by default (intercept.mjs); saved-tile
// scenarios stub their own list. The clock is pinned to 2026-09-07, so a
// rolling 90-day range lands inside the bundled seed window.

// One saved tile, the row shape rowToTile reads.
const MILEAGE_TILE_ROW = {
  user_id: 'mock-user',
  id: 'tile-mileage',
  spec: {
    version: 1,
    title: 'Weekly mileage',
    chartType: 'line',
    range: { kind: 'rolling', days: 90 },
    bucket: 'week',
    series: [{ id: 's1', measure: 'distance' }],
  },
  x: 0, y: 0, w: 6, h: 4,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

test('empty dashboard explains itself and the builder saves a tile', async ({ page }) => {
  const posted: Array<Record<string, unknown>> = [];
  await page.route('**/api/analytics-tiles', async route => {
    posted.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'tile-x' }) });
  });

  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await expect(page.getByTestId('analytics-view')).toBeVisible();
  await expect(page.getByTestId('analytics-empty')).toContainText('New tile');
  await shot(page, 'analytics-empty');

  await page.getByTestId('analytics-new-tile').click();
  await page.getByTestId('tile-title').fill('Training sessions');

  // Pick a measure; the preview renders from the same spec Save persists.
  await page.getByRole('radio', { name: 'Sessions', exact: true }).click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  // A line chart over the (empty) mock data still draws its axes as SVG.
  await expect(page.getByTestId('tile-preview').locator('svg')).toBeVisible();
  await shot(page, 'analytics-builder');

  await page.getByTestId('tile-save').click();

  // The wire payload is the whole contract: spec + layout columns.
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    spec: {
      version: 1,
      title: 'Training sessions',
      chartType: 'line',
      bucket: 'week',
      series: [{ id: 's1', measure: 'session-count' }],
    },
    x: 0, y: 0, w: 6, h: 4,
  });
  expect(String(posted[0].id)).toMatch(/^tile-/);

  // Optimistic save: the tile is in the grid without waiting for realtime.
  await expect(page.getByTestId('analytics-empty')).toBeHidden();
  await expect(page.locator('.tile-card__title')).toHaveText('Training sessions');

  const state = await apexState<{ tiles: Array<{ title: string; measures: string[] }> }>(page, 'analytics');
  expect(state.tiles).toHaveLength(1);
  expect(state.tiles[0].measures).toEqual(['session-count']);
  await shot(page, 'analytics-grid');
});

test('a saved tile renders and edits round-trip through the builder', async ({ page }) => {
  await page.route(/rest\/v1\/analytics_tiles/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MILEAGE_TILE_ROW]) });
  });

  await gotoCalendar(page);
  await page.getByTestId('nav-analytics').click();
  await expect(page.locator('.tile-card__title')).toHaveText('Weekly mileage');

  // Edit opens the builder prefilled from the stored spec.
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

  // Max grade without a scale is the canonical spec-level violation.
  await page.getByRole('radio', { name: 'Max grade', exact: true }).click();
  await expect(page.getByTestId('tile-builder-problem')).toContainText('grade scale');

  await page.getByRole('radio', { name: 'YDS', exact: true }).click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
});

test('mobile: the analytics button opens the dashboard as a stacked list', async ({ page }) => {
  await page.route(/rest\/v1\/analytics_tiles/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MILEAGE_TILE_ROW]) });
  });
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
