import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// First-run onboarding against a "fresh" profile stub (both template_copied_at
// and onboarding_dismissed_at null). Covers the contract that matters: the
// welcome flow shows once and latches, the COROS card is absent on a
// deployment without a watch provider, and the checklist reflects real state
// rather than anything onboarding stored for itself.
//
// The context stub in intercept.mjs answers provider-sync with
// configured:false and mcp-tokens with an empty list, so the COROS step and
// the connector row behave as they would on a deployment with no COROS env.

test.use({ freshProfile: true });

// WELCOME_STEPS minus the COROS card, which requires a configured provider.
const STEPS_WITHOUT_COROS = 7;

test('welcome flow runs, latches, and hands off to the checklist', async ({ page }) => {
  await gotoCalendar(page);

  const welcome = page.locator('.welcome');
  await expect(welcome, 'a fresh account meets the welcome flow first').toBeVisible();
  await expect(welcome.locator('.welcome__count')).toHaveText(`Step 1 of ${STEPS_WITHOUT_COROS}`);
  await expect(welcome.locator('.welcome__dot')).toHaveCount(STEPS_WITHOUT_COROS);
  await shot(page, 'onboarding-welcome');

  // No Back on the first card; Next advances and Back returns.
  await expect(welcome.locator('.welcome__back')).toHaveCount(0);
  await welcome.locator('.welcome__next').click();
  await expect(welcome.locator('.welcome__count')).toHaveText(`Step 2 of ${STEPS_WITHOUT_COROS}`);
  await welcome.locator('.welcome__back').click();
  await expect(welcome.locator('.welcome__count')).toHaveText(`Step 1 of ${STEPS_WITHOUT_COROS}`);

  // Walk to the end. No card should mention the watch on this deployment.
  const titles: string[] = [];
  for (let i = 0; i < STEPS_WITHOUT_COROS; i += 1) {
    titles.push((await welcome.locator('.welcome__title').textContent()) ?? '');
    if (i < STEPS_WITHOUT_COROS - 1) await welcome.locator('.welcome__next').click();
  }
  expect(titles.join(' ')).not.toMatch(/COROS|watch/i);
  await expect(welcome.locator('.welcome__next'), 'the last card commits').toHaveText('Start training');
  await shot(page, 'onboarding-welcome-last');

  // Finishing latches it: the flow goes, the calendar nudge takes over.
  await welcome.locator('.welcome__next').click();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.setup-nudge'), 'the nudge picks up where the flow left off').toBeVisible();
});

test('the nudge tracks live state and is dismissible for the session', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.welcome__skip').click();

  const nudge = page.locator('.setup-nudge');
  await expect(nudge).toBeVisible();
  // Three local-signal rows; the key one is ticked because the stubbed
  // /api/profile reports a saved key, the other two are genuinely undone.
  await expect(nudge.locator('.setup-nudge__row')).toHaveCount(3);
  await expect(nudge.locator('.setup-nudge__row--done')).toHaveCount(1);
  await expect(nudge.locator('.setup-nudge__score')).toHaveText('1/3');
  await shot(page, 'onboarding-nudge');

  await nudge.locator('.setup-nudge__dismiss').click();
  await expect(nudge).toHaveCount(0);
});

test('the checklist lives in Profile and omits rows the deployment cannot honour', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.welcome__skip').click();
  await expect(page.locator('.welcome')).toHaveCount(0);

  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();

  const rows = page.locator('.setup__row');
  // template, key, goal, connector — no COROS row without a configured provider.
  await expect(rows).toHaveCount(4);
  await expect(page.locator('.setup__label')).not.toContainText(['Connect your watch']);
  await expect(page.locator('.setup__row--done'), 'only the saved API key is done').toHaveCount(1);
  await expect(page.locator('.setup__score')).toHaveText('1/4');
  await shot(page, 'onboarding-checklist');

  // Undone rows offer their action; done rows don't.
  await expect(page.locator('.setup__row--done .setup__action')).toHaveCount(0);
  await expect(page.locator('.setup__action')).toHaveCount(3);
});

test('welcome flow and nudge survive a phone viewport', async ({ page }) => {
  await gotoCalendar(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const welcome = page.locator('.welcome');
  await expect(welcome).toBeVisible();
  await shot(page, 'onboarding-welcome-mobile');

  await welcome.locator('.welcome__skip').click();
  const nudge = page.locator('.setup-nudge');
  await expect(nudge).toBeVisible();

  // The nudge is fixed to the bottom and the mobile tab bar is too — it must
  // clear the bar rather than bury the Calendar/Analytics tabs.
  const nav = page.locator('.mobile-nav');
  await expect(nav).toBeVisible();
  const nudgeBox = await nudge.boundingBox();
  const navBox = await nav.boundingBox();
  expect(nudgeBox && navBox && nudgeBox.y + nudgeBox.height <= navBox.y).toBe(true);
  await shot(page, 'onboarding-nudge-mobile');
});

test('the nudge stays out of the way while an overlay is open', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.welcome__skip').click();
  await expect(page.locator('.setup-nudge')).toBeVisible();

  // It is position: fixed — over the tracker or the library it would be junk.
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await expect(page.locator('.setup-nudge')).toHaveCount(0);
});
