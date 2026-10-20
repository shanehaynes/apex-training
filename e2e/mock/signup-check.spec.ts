import { test, expect, supabaseRef } from '../lib/fixtures';

// /signup-check is the page the iOS app's Create account shows in a web view
// to get a Turnstile token (src/components/auth/SignupCheckPage.tsx). It
// serves a visitor with no account, so it must render signed out, above the
// auth gate, like /terms and /help. The mock build has no site key, so the
// page states that sign-up is closed instead of showing a broken widget.
test.use({ sessionSeed: false, freshProfile: false });

test('renders signed out, above the sign-in card', async ({ page }) => {
  test.skip(!supabaseRef(), 'offline mode has no auth gate');
  await page.goto('/signup-check');
  await expect(page.getByTestId('signup-check')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('signup-check')).toContainText("Sign-up isn't open right now.");
  await expect(page.locator('.auth-toggle')).toHaveCount(0);
});
