import { test, expect, shot, supabaseRef } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { fabricatedSession } from '../lib/session.mjs';

// Start signed out to exercise LoginView. The profile stub is deliberately
// NOT fresh — first-run onboarding is onboarding.spec.ts's job, and its modal
// would sit over everything this spec wants to click.
test.use({ sessionSeed: false, freshProfile: false });

test('login gate, reset mode, fabricated session, profile view', async ({ page }) => {
  const ref = supabaseRef();
  test.skip(!ref, 'offline mode has no auth gate — nothing to drive');

  // Signed out → login screen.
  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('input[name="email"]')).toHaveAttribute('autocomplete', 'email');
  await expect(page.locator('input[name="password"]')).toHaveAttribute('autocomplete', 'current-password');
  await shot(page, 'auth-login');

  // The toggle swaps the same form into create mode: invite-only note, the
  // password field asks the password manager for a *new* one, no reset link.
  await expect(page.locator('.auth-hint')).toHaveCount(0);
  await page.locator('.auth-toggle__option', { hasText: 'Create account' }).click();
  await expect(page.locator('.auth-hint')).toHaveText('Account creation is invite only.');
  await expect(page.locator('input[name="password"]')).toHaveAttribute('autocomplete', 'new-password');
  await expect(page.locator('.auth-submit')).toHaveText('Create account');
  await expect(page.locator('.auth-link', { hasText: 'Forgot' })).toHaveCount(0);
  await shot(page, 'auth-create');
  await page.locator('.auth-toggle__option', { hasText: 'Sign in' }).click();
  await expect(page.locator('.auth-hint')).toHaveCount(0);
  await expect(page.locator('input[name="password"]')).toHaveAttribute('autocomplete', 'current-password');

  // Forgot-password swaps the form to reset mode (and hides the toggle).
  await page.locator('.auth-link', { hasText: 'Forgot' }).click();
  await expect(page.locator('input[name="password"]'), 'reset mode hides the password field').toHaveCount(0);
  await expect(page.locator('.auth-toggle')).toHaveCount(0);
  await shot(page, 'auth-reset');

  // Seed the fabricated session and reload → signed-in app with avatar.
  await page.evaluate(([key, session]) => {
    localStorage.setItem(key as string, JSON.stringify(session));
  }, [`sb-${ref}-auth-token`, fabricatedSession()] as const);
  await page.reload();
  await expect(page.locator('.top-nav__avatar')).toBeVisible({ timeout: 20000 });
  await shot(page, 'auth-signed-in');

  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  // Set-once settings are collapsed by default; the header keeps their state
  // in view, and the controls come back on expanding.
  const keyFold = page.locator('.profile-fold', { hasText: 'Anthropic API key' });
  await expect(keyFold.locator('.profile-fold__status')).toHaveText('Saved · …abcd');
  await expect(page.locator('input[aria-label="Saved API key (masked)"]')).toHaveCount(0);
  await expect(page.locator('.profile-avatar')).toHaveCount(0);
  await shot(page, 'auth-profile');

  await page.locator('.profile-fold__toggle', { hasText: 'Avatar' }).click();
  // One tile per entry in the avatar library (src/lib/profile/avatars.ts).
  await expect(page.locator('.profile-avatar')).toHaveCount(24);
  await keyFold.locator('.profile-fold__toggle').click();
  await page.locator('.profile-fold__toggle', { hasText: 'Calendar feed' }).click();

  const feedUrls = await page.locator('.profile-feed__url')
    .evaluateAll(els => els.map(el => (el as HTMLInputElement).value));
  expect(feedUrls.some(u => u.includes('/api/calendar-feed?token=driver-ics-token')),
    'feed URL carries the profile ics token').toBe(true);
  // API key fold: masked key + Replace/Remove (stubbed hasKey=true).
  expect(feedUrls.some(u => u === 'sk-ant-…abcd'),
    'the API key fold shows the masked key').toBe(true);
  const keyButtons = await page.locator('.profile-feed .btn-today').allTextContents();
  expect(keyButtons.map(t => t.trim())).toEqual(expect.arrayContaining(['Replace', 'Remove']));
  await shot(page, 'auth-profile-expanded');
});

// The landing an expired or already-clicked invite produces. GoTrue verifies
// the token itself and, on refusal, redirects to the app with no session and
// the reason in the fragment — this is the live project's exact wording,
// captured with a bogus token. The visitor must be told; the tab they reach
// for next is create-account, which is closed, so losing this message on the
// switch leaves them staring at "accounts are created by invitation".
test('a spent invite link explains itself, and keeps explaining after the tab switch', async ({ page }) => {
  test.skip(!supabaseRef(), 'offline mode has no auth gate — nothing to drive');

  await page.goto('/#error=access_denied&error_code=otp_expired'
    + '&error_description=Email+link+is+invalid+or+has+expired&sb=');

  const banner = page.getByTestId('auth-link-error');
  await expect(banner).toBeVisible({ timeout: 20000 });
  await expect(banner).toContainText('expired, or it has already been used');
  await shot(page, 'auth-link-expired');

  // Every mode this card has, including the one the loop ran through:
  // create-account, whose invite-only note used to be all that was left.
  await page.locator('.auth-toggle__option', { hasText: 'Create account' }).click();
  await expect(page.locator('.auth-hint')).toHaveText('Account creation is invite only.');
  await expect(banner, 'the reason survives the switch to create').toBeVisible();

  await page.locator('.auth-toggle__option', { hasText: 'Sign in' }).click();
  await expect(banner, 'and the switch back').toBeVisible();

  await page.locator('.auth-link', { hasText: 'Forgot' }).click();
  await expect(page.locator('.auth-toggle')).toHaveCount(0);
  await expect(banner, 'and reset mode, which hides the toggle').toBeVisible();
});

// The iOS hand-off (docs/ios/decisions.md D-020). A `?code=` landing is a PKCE
// password reset the app requested; the web cannot exchange it, so the card
// offers to open the app with that code. A plain landing offers nothing —
// the link must never appear to someone who simply came to sign in.
test('a reset code the app requested is offered to the app, and nothing else is', async ({ page }) => {
  test.skip(!supabaseRef(), 'offline mode has no auth gate — nothing to drive');

  await page.goto('/?code=abc%2Fdef');
  const open = page.getByTestId('open-in-app');
  await expect(open).toBeVisible({ timeout: 20000 });
  await expect(open).toHaveAttribute('href', 'apextraining://auth?code=abc%2Fdef');
  await expect(open).toHaveText('Open in the Apex app');
  await shot(page, 'auth-open-in-app');

  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('open-in-app')).toHaveCount(0);
});
