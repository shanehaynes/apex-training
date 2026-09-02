import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// The illustrated connector guide reached from the help icon on the profile's
// AI connector section. What matters here is the navigation contract — the
// guide takes over the profile overlay rather than stacking a second one, so
// Escape has to step back one level instead of dumping the user on the
// calendar — plus the fact that every client tab actually renders figures.

const openGuide = async (page: import('@playwright/test').Page) => {
  await gotoCalendar(page);
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await page.locator('.profile-help').click();
  await expect(page.locator('.cg-tabs')).toBeVisible();
};

test('the help icon opens the guide, and Escape steps back to the profile', async ({ page }) => {
  await openGuide(page);
  await expect(page.locator('.library-header__title')).toHaveText('Connecting an AI assistant');
  await shot(page, 'connector-guide');

  // Claude is the default tab: four numbered steps, each with an annotated figure.
  await expect(page.locator('.cg-step')).toHaveCount(4);
  await expect(page.locator('.cg-figure')).toHaveCount(4);

  // Escape backs out of the guide without closing the profile behind it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.cg-tabs')).toHaveCount(0);
  await expect(page.locator('.profile-help'), 'the profile is still open').toBeVisible();

  // A second Escape closes the profile, as it did before the guide existed.
  await page.keyboard.press('Escape');
  await expect(page.locator('.profile-view')).toHaveCount(0);
});

test('every client tab renders its own instructions', async ({ page }) => {
  await openGuide(page);

  const tabs = page.locator('.cg-tab');
  await expect(tabs).toHaveCount(4);

  // ChatGPT: three figures (developer mode, create, in-chat) plus the shared
  // Apex consent screen.
  await tabs.nth(1).click();
  await expect(page.locator('.cg-figure')).toHaveCount(4);
  await expect(page.getByText('Developer mode', { exact: false }).first()).toBeVisible();

  // Claude Code is token-based: one figure, and a copyable command carrying
  // this deployment's own endpoint.
  await tabs.nth(2).click();
  await expect(page.locator('.cg-figure')).toHaveCount(1);
  await expect(page.locator('.cg-code').first()).toContainText('claude mcp add --transport http apex');
  await expect(page.locator('.cg-code').first()).toContainText('/api/mcp');

  // The catch-all tab is text and code only — no vendor screens to draw.
  await tabs.nth(3).click();
  await expect(page.locator('.cg-figure')).toHaveCount(0);
  await expect(page.locator('.cg-code').first()).toContainText('Authorization: Bearer apx_');

  // The endpoint offered at the top is the same one the AI connector section
  // shows, so a user copying from either place pastes the same string.
  const guideUrl = await page.locator('.cg-body .profile-feed__url').inputValue();
  await page.locator('.library-back').click();
  // The help icon sits outside the fold's toggle, so it is reachable while the
  // AI connector section is collapsed — expanding is only for the URL below.
  await expect(page.locator('.profile-help')).toBeVisible();
  await page.locator('.profile-fold__toggle', { hasText: 'AI connector' }).click();
  const sectionUrl = await page.locator('input[aria-label="MCP endpoint URL"]').inputValue();
  expect(guideUrl).toBe(sectionUrl);
});
