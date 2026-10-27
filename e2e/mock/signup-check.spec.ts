import type { Page } from '@playwright/test';
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

// With a site key (the dev-only override, as e2e/mock/open-signup.spec.ts
// uses) and a fake widget standing in for Cloudflare's script, the page's one
// job: hand the app what the widget says, as JSON strings, over the
// `turnstile` message handler — a stub here records them.
const FAKE_TURNSTILE = `window.turnstile = {
  render: (el, opts) => { setTimeout(() => opts.callback('fake-token'), 0); return 'w1'; },
  reset: () => {},
  remove: () => {},
};`;

test.describe('with a site key', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!supabaseRef(), 'offline mode has no auth gate');
    await page.addInitScript(() => {
      (window as { __APEX_TURNSTILE_SITE_KEY__?: string }).__APEX_TURNSTILE_SITE_KEY__ = 'test-site-key';
    });
  });

  function stubTheApp(page: Page) {
    return page.addInitScript(() => {
      const posted: string[] = [];
      (window as unknown as { __posted: string[] }).__posted = posted;
      (window as unknown as { webkit: unknown }).webkit = {
        messageHandlers: { turnstile: { postMessage: (body: string) => posted.push(body) } },
      };
    });
  }
  const posted = (page: Page) =>
    page.evaluate(() => (window as unknown as { __posted: string[] }).__posted);

  test('posts the token to the app', async ({ page }) => {
    await stubTheApp(page);
    await page.route('https://challenges.cloudflare.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE }));
    await page.goto('/signup-check');
    await expect(page.getByTestId('signup-check')).toContainText('One quick check that you are a person.', { timeout: 20000 });
    await expect.poll(() => posted(page)).toEqual(['{"token":"fake-token"}']);
    await expect(page.getByTestId('signup-check')).not.toContainText('This page is for the Apex iPhone app.');
  });

  // A failing widget calls error-callback; the app needs to hear that no token
  // is coming, or its sheet waits forever. (A failed script load takes the
  // same path in TurnstileWidget, but Chromium logs it as a console error.)
  test('tells the app no token is coming when the widget errors', async ({ page }) => {
    await stubTheApp(page);
    await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: FAKE_TURNSTILE.replace("opts.callback('fake-token')", "opts['error-callback']()"),
    }));
    await page.goto('/signup-check');
    await expect(page.getByTestId('signup-check')).toContainText('One quick check that you are a person.', { timeout: 20000 });
    // Dev StrictMode may run the widget's effect twice; every message must still say "no token".
    await expect.poll(async () => {
      const messages = await posted(page);
      return messages.length > 0 && messages.every(m => m === '{"expired":true}');
    }).toBe(true);
  });

  test('says what it is for when opened outside the app', async ({ page }) => {
    await page.route('https://challenges.cloudflare.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE }));
    await page.goto('/signup-check');
    await expect(page.getByTestId('signup-check')).toContainText('This page is for the Apex iPhone app.', { timeout: 20000 });
  });
});
