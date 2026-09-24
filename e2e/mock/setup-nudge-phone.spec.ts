import type { Locator, Page } from '@playwright/test';
import { test, expect, shot } from '../lib/fixtures';

// A brand-new user — the only kind who sees the "Finish setting up" nudge —
// must be able to use the bottom nav's + menu without closing the nudge
// first. On a 375 px phone the menu opens upward into the nudge's space, and
// the nudge used to sit over Workout and Meal.

test.use({ freshProfile: true, viewport: { width: 375, height: 812 } });

async function skipWelcome(page: Page) {
  await page.goto('/');
  await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
  await page.locator('.welcome__skip').click();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.setup-nudge')).toBeVisible();
}

/** Opens +, and proves no nudge box overlaps any of the menu's items. */
async function openAddMenu(page: Page): Promise<Locator> {
  await page.locator('.mobile-nav__add').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  const nudge = page.locator('.setup-nudge');
  const nudgeBox = (await nudge.count()) ? await nudge.boundingBox() : null;
  for (const item of await menu.getByRole('menuitem').all()) {
    const box = await item.boundingBox();
    expect(box, 'menu item is laid out').not.toBeNull();
    const overlaps = !!nudgeBox && !!box
      && nudgeBox.x < box.x + box.width && box.x < nudgeBox.x + nudgeBox.width
      && nudgeBox.y < box.y + box.height && box.y < nudgeBox.y + nudgeBox.height;
    expect(overlaps, `the nudge does not cover "${await item.textContent()}"`).toBe(false);
  }
  return menu;
}

test('the + menu stays tappable while the setup nudge is up', async ({ page }) => {
  await skipWelcome(page);

  let menu = await openAddMenu(page);
  await shot(page, 'setup-nudge-phone-add-menu');
  // A plain click: Playwright refuses it if another element takes the tap.
  await menu.getByRole('menuitem', { name: 'Workout' }).click();
  await expect(page.locator('.builder-search')).toBeVisible();

  // Closing the builder brings the nudge back — nothing dismissed it.
  await page.locator('.builder-view .library-close[aria-label="Close"]').click();
  await expect(page.locator('.builder-view')).toHaveCount(0);
  await expect(page.locator('.setup-nudge')).toBeVisible();

  menu = await openAddMenu(page);
  await menu.getByRole('menuitem', { name: 'Meal' }).click();
  await expect(page.locator('.meal-form')).toBeVisible();
});

test('closing the + menu brings the nudge back, still clear of the tab bar', async ({ page }) => {
  await skipWelcome(page);

  await openAddMenu(page);
  await page.locator('.mobile-nav__add').click();
  await expect(page.getByRole('menu')).toHaveCount(0);

  const nudge = page.locator('.setup-nudge');
  await expect(nudge).toBeVisible();
  const nudgeBox = await nudge.boundingBox();
  const navBox = await page.locator('.mobile-nav').boundingBox();
  expect(nudgeBox && navBox && nudgeBox.y + nudgeBox.height <= navBox.y).toBe(true);
});
