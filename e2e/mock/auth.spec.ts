import { test, expect, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { fabricatedSession } from '../lib/session.mjs';

// Start signed out to exercise LoginView; the profile stub is "fresh" so the
// template-offer banner renders after sign-in.
test.use({ sessionSeed: false, freshProfile: true });

test('login gate, reset mode, fabricated session, profile view', async ({ page, supabaseRef }) => {
  test.skip(!supabaseRef, 'offline mode has no auth gate — nothing to drive');

  // Signed out → login screen.
  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('input[name="email"]')).toHaveAttribute('autocomplete', 'email');
  await expect(page.locator('input[name="password"]')).toHaveAttribute('autocomplete', 'current-password');
  await shot(page, 'auth-login');

  // Forgot-password swaps the form to reset mode.
  await page.locator('.auth-link', { hasText: 'Forgot' }).click();
  await expect(page.locator('input[name="password"]'), 'reset mode hides the password field').toHaveCount(0);
  await shot(page, 'auth-reset');

  // Seed the fabricated session and reload → signed-in app with avatar.
  await page.evaluate(([key, session]) => {
    localStorage.setItem(key as string, JSON.stringify(session));
  }, [`sb-${supabaseRef}-auth-token`, fabricatedSession()] as const);
  await page.reload();
  await expect(page.locator('.top-nav__avatar')).toBeVisible({ timeout: 20000 });
  // The stubbed profile has template_copied_at null in this spec.
  await expect(page.locator('.template-offer'), 'template-offer banner shows for a fresh account').toBeVisible();
  await shot(page, 'auth-signed-in');

  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await expect(page.locator('.profile-avatar')).toHaveCount(5);

  const feedUrls = await page.locator('.profile-feed__url')
    .evaluateAll(els => els.map(el => (el as HTMLInputElement).value));
  expect(feedUrls.some(u => u.includes('/api/calendar-feed?token=driver-ics-token')),
    'feed URL carries the profile ics token').toBe(true);
  // AI Coach section: masked key + Replace/Remove (stubbed hasKey=true).
  expect(feedUrls.some(u => u === 'sk-ant-…abcd'),
    'AI Coach section shows the masked key').toBe(true);
  const keyButtons = await page.locator('.profile-feed .btn-today').allTextContents();
  expect(keyButtons.map(t => t.trim())).toEqual(expect.arrayContaining(['Replace', 'Remove']));
  await shot(page, 'auth-profile');
});
