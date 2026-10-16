import { test, expect } from '../lib/fixtures';

// Block detail's progress load: a failed read says so instead of spinning on
// "Loading…" forever, and the stubbed-empty reads still render progress.
// The mock clock is 2026-09-07 (a Monday, playwright.config.ts).

const BLOCK = {
  id: 'blk-base', user_id: 'mock-user', objective_id: null, name: 'Base', intent: 'Aerobic foundation.',
  phase: 'base', start_date: '2026-09-07', end_date_exclusive: '2026-10-05',
  weekly_targets: { cardio_minutes: 300 }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};

async function openBlock(page: import('@playwright/test').Page) {
  await page.route(/rest\/v1\/training_blocks/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([BLOCK]) }));
  await page.goto('/');
  await expect(page.locator('.top-nav')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('nav-blocks').click();
  await page.locator('.block-row', { hasText: 'Base' }).click();
  await expect(page.locator('.library-header__title')).toHaveText('Base');
}

test('block detail renders progress when its reads succeed', async ({ page }) => {
  await openBlock(page);
  await expect(page.getByText(/of 4 weeks complete/)).toBeVisible();
  await expect(page.locator('.block-detail [role="alert"]')).toHaveCount(0);
});

test('block detail says so when its progress cannot load', async ({ page }) => {
  // 500, not 503: postgrest-js retries a 503 with backoff (see intercept.mjs).
  await page.route(/rest\/v1\/workout_completions/, route =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) }));
  await openBlock(page);
  await expect(page.locator('.block-detail [role="alert"]')).toContainText("Couldn't load this block's progress");
  await expect(page.locator('.block-detail [aria-busy="true"]')).toHaveCount(0);
});
