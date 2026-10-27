import { test, expect, supabaseRef } from '../lib/fixtures';

// Open sign-up's form (docs/specs/open-signup.md M1). The mock build has no
// VITE_TURNSTILE_SITE_KEY, so the spec opens the mode through the dev-only
// window override (src/lib/auth/turnstile.ts) and stands a fake widget in
// for Cloudflare's script — no network, a token on render.

const FAKE_TURNSTILE = `window.turnstile = {
  render: (el, opts) => { setTimeout(() => opts.callback('fake-token'), 0); return 'w1'; },
  reset: () => {},
  remove: () => {},
};`;

test.describe('open sign-up', () => {
  test.use({ sessionSeed: false, freshProfile: false });

  test.beforeEach(async ({ page }) => {
    test.skip(!supabaseRef(), 'offline mode has no auth gate');
    await page.addInitScript(() => {
      (window as { __APEX_TURNSTILE_SITE_KEY__?: string }).__APEX_TURNSTILE_SITE_KEY__ = 'test-site-key';
    });
    await page.route('https://challenges.cloudflare.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE }));
  });

  test('asks for an email, both boxes and a token — and sends the attestation', async ({ page }) => {
    let sent: Record<string, unknown> | null = null;
    await page.route('**/api/signup', async route => {
      sent = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending"}' });
    });

    await page.goto('/');
    await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
    await page.locator('.auth-toggle__option', { hasText: 'Create account' }).click();

    const age = page.getByTestId('age-confirm');
    const terms = page.locator('#accept-legal-signup');
    const submit = page.locator('.auth-submit');

    // No password: the mailed invite is where it is chosen.
    await expect(page.locator('input[name="password"]')).toHaveCount(0);
    await expect(age, 'the 18+ box must never start checked').not.toBeChecked();

    await page.locator('input[name="email"]').fill('someone@example.com');
    await terms.check();
    await expect(submit, 'terms alone is not enough').toBeDisabled();
    await age.check();
    await expect(submit).toBeEnabled();

    await submit.click();
    await expect(page.locator('.auth-note')).toContainText('someone@example.com');
    expect(sent).toEqual({ email: 'someone@example.com', captchaToken: 'fake-token', ageConfirmed: true });
  });

  test('a second visit to the form starts with both boxes unticked', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
    const create = page.locator('.auth-toggle__option', { hasText: 'Create account' });
    await create.click();
    await page.getByTestId('age-confirm').check();
    await page.locator('#accept-legal-signup').check();

    await page.locator('.auth-toggle__option', { hasText: 'Sign in' }).click();
    await create.click();
    await expect(page.getByTestId('age-confirm')).not.toBeChecked();
    await expect(page.locator('#accept-legal-signup')).not.toBeChecked();
  });
});
