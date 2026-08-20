import { test, expect, shot } from '../lib/fixtures';

// The coach pane is the second mobile tab, and its input row is the last child
// of a column that has to end exactly at the fixed bottom nav. It regressed
// once already: .app-shell's base min-height: 100vh outranked the mobile
// height: 100dvh, and .app-body's flex: 1 grew past its own height calc, which
// pushed the textarea under (and on a real phone, below) the tab bar.

test.use({ viewport: { width: 390, height: 844 } });

/** Bottom edge the chat column must not cross: the top of the fixed nav. */
async function navTop(page: import('@playwright/test').Page) {
  return (await page.locator('.mobile-nav').boundingBox())!.y;
}

test('the coach input row sits above the mobile tab bar', async ({ page }) => {
  await page.goto('/');
  await page.locator('.mobile-nav').waitFor({ state: 'visible', timeout: 20000 });

  await page.locator('.mobile-nav__tab').nth(1).click();
  const inputRow = page.locator('.chat-sidebar__input-row');
  await expect(inputRow).toBeVisible();

  const row = (await inputRow.boundingBox())!;
  expect(row.y + row.height, 'input row is fully above the tab bar').toBeLessThanOrEqual(await navTop(page) + 1);
  await expect(page.locator('.chat-input')).toBeVisible();
  await expect(page.locator('.chat-notes-btn')).toBeVisible();

  // The onboarding nudge is fixed just above the tab bar — on this tab that is
  // where the input row lives, so it must not render here.
  await expect(page.locator('.setup-nudge')).toBeHidden();
  await shot(page, 'mobile-coach-chat');
});

test('the input row survives a phone browser toolbar', async ({ page }) => {
  await page.goto('/');
  await page.locator('.mobile-nav').waitFor({ state: 'visible', timeout: 20000 });

  // Headless Chromium has no retractable toolbar, so 100vh === 100dvh and the
  // real-device gap can't occur on its own. Restating the shell taller than
  // the visible viewport reproduces what a phone's vh does.
  await page.addStyleTag({
    content: '.app-shell { min-height: calc(100dvh + 90px) !important; }',
  });
  await page.locator('.mobile-nav__tab').nth(1).click();

  const row = (await page.locator('.chat-sidebar__input-row').boundingBox())!;
  expect(row.y + row.height, 'chat column is pinned to the viewport, not the shell')
    .toBeLessThanOrEqual(await navTop(page) + 1);
});
