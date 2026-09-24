import { test, expect, gotoCalendar } from '../lib/fixtures';

// /help and /help/<slug> render above AuthProvider (src/App.tsx), so a link
// from an email, a tip or the iOS app works whether or not the reader is
// signed in. Page content belongs to each page's lane; this pins the shell.

const PAGE_COUNT = 5;

test.describe('help pages, signed out', () => {
  test.use({ sessionSeed: false });

  test('/help lists every page with its summary', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
    await expect(page.locator('.help-index__item')).toHaveCount(PAGE_COUNT);
    await expect(page.getByRole('link', { name: 'Get an API key' })).toHaveAttribute('href', '/help/get-api-key');
    await expect(page.locator('.help-index__summary').first()).not.toBeEmpty();
    await expect(page).toHaveTitle('Help');
    // Above the auth gate: no sign-in form in front of the page.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test('/help/<slug> renders the page with its chrome', async ({ page }) => {
    await page.goto('/help/get-api-key');
    await expect(page.getByRole('heading', { level: 1, name: 'Get an API key' })).toBeVisible();
    await expect(page).toHaveTitle('Get an API key');
    await expect(page.getByRole('link', { name: '← Apex Training' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('link', { name: 'All help' })).toHaveAttribute('href', '/help');
    // The lane-note comment in the source never reaches the reader.
    await expect(page.locator('.help__body')).not.toContainText('Lane F04');
  });

  test('an unknown slug falls back to the index', async ({ page }) => {
    await page.goto('/help/nope');
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
    await expect(page.locator('.help-index__item')).toHaveCount(PAGE_COUNT);
  });

  test('a phone viewport never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ['/help', '/help/get-api-key', '/help/logging-a-workout']) {
      await page.goto(path);
      await expect(page.locator('.help__h1')).toBeVisible();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, path).toBeLessThanOrEqual(375);
    }
  });
});

test.describe('help pages, signed in', () => {
  test('/help/get-api-key renders, not the calendar', async ({ page }) => {
    await page.goto('/help/get-api-key');
    await expect(page.getByRole('heading', { level: 1, name: 'Get an API key' })).toBeVisible();
    await expect(page.locator('.event-chip__main')).toHaveCount(0);
  });

  test('Profile links to /help in a new tab', async ({ page }) => {
    await gotoCalendar(page);
    await page.getByRole('button', { name: 'Open profile' }).click();
    const link = page.locator('.profile-view').getByRole('link', { name: 'Help pages' });
    await expect(link).toHaveAttribute('href', '/help');
    await expect(link).toHaveAttribute('target', '_blank');
  });
});
