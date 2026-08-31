import { test, expect, shot, supabaseRef } from '../lib/fixtures';
import { LEGAL_DOCUMENTS, PRIVACY_VERSION, TERMS_VERSION } from '../../src/lib/legal/versions';

// Clickwrap in the browser. The server gate (api/_lib/auth.ts) is what makes
// the agreement enforceable and is covered by api/__tests__/auth.test.ts and
// the integration suite; what these specs cover is the other half a court
// looks at — whether the terms were conspicuous, and whether assent was an
// affirmative act rather than a pre-ticked box nobody saw.

test.describe('signup', () => {
  // Signed out, so LoginView renders. Not a fresh profile: the onboarding
  // modal would sit over the form.
  test.use({ sessionSeed: false, freshProfile: false });

  test('create-account blocks submit until the box is ticked', async ({ page }) => {
    test.skip(!supabaseRef(), 'offline mode has no auth gate');
    await page.goto('/');
    await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });

    // Sign-in mode asks for no agreement — only account creation does.
    await expect(page.locator('.legal-accept')).toHaveCount(0);

    await page.locator('.auth-toggle__option', { hasText: 'Create account' }).click();
    const box = page.locator('.legal-accept__box');
    const submit = page.locator('.auth-submit');

    await expect(box).toBeVisible();
    // The single most common reason a clickwrap is held unenforceable is a
    // pre-checked box: there is no affirmative act to point at.
    await expect(box, 'the box must never start checked').not.toBeChecked();
    await expect(submit).toBeDisabled();

    await page.locator('input[name="email"]').fill('someone@example.com');
    await page.locator('input[name="password"]').fill('a-long-enough-password');
    await expect(submit, 'a filled form is still blocked by the unticked box').toBeDisabled();
    await shot(page, 'clickwrap-signup-blocked');

    await box.check();
    await expect(submit).toBeEnabled();

    // And it is genuinely reversible — not a one-way latch that lets a
    // mis-click stand as consent.
    await box.uncheck();
    await expect(submit).toBeDisabled();
  });

  test('both documents are linked next to the box, not in a footer', async ({ page }) => {
    test.skip(!supabaseRef(), 'offline mode has no auth gate');
    await page.goto('/');
    await page.locator('.auth-toggle__option', { hasText: 'Create account' }).click();

    const label = page.locator('.legal-accept__label');
    for (const doc of LEGAL_DOCUMENTS) {
      const link = label.locator(`a[href="${doc.path}"]`);
      await expect(link, `${doc.title} must be linked at the point of assent`).toBeVisible();
      await expect(link).toHaveText(doc.title);
      // A new tab, so reading the terms never discards a half-filled form.
      await expect(link).toHaveAttribute('target', '_blank');
    }
    // The versions being agreed to are visible, and match what the server
    // will write to the ledger.
    await expect(page.locator('.legal-accept__versions'))
      .toHaveText(`(${TERMS_VERSION}, ${PRIVACY_VERSION})`);
  });
});

test.describe('re-acceptance after a version bump', () => {
  test.use({ staleTerms: true });

  test('an outdated acceptance raises a blocking gate over the whole app', async ({ page }) => {
    await page.goto('/');
    const gate = page.locator('#terms-gate-title');
    await expect(gate, 'a stale acceptance must stop the app loading').toBeVisible({ timeout: 20000 });
    await expect(gate).toHaveText('Our terms have changed');

    // The calendar must not be behind it: mounting the data providers would
    // fire reads the server 403s and bury the modal in failure toasts.
    await expect(page.locator('.event-chip__main')).toHaveCount(0);
    await shot(page, 'clickwrap-reacceptance-gate');

    // The earlier acceptance is shown, and described as kept — this is the
    // append-only ledger surfacing in the UI.
    const previous = page.locator('.legal-accept__previous');
    await expect(previous).toContainText('terms-v0');
    await expect(previous).toContainText('That record is kept');

    // Not dismissible: no close button, and Escape does nothing.
    await expect(page.locator('.modal-close')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(gate).toBeVisible();
  });

  test('the gate needs a fresh tick, then lets the app through', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#terms-gate-title')).toBeVisible({ timeout: 20000 });

    const box = page.locator('#accept-legal-gate');
    const accept = page.locator('.welcome__action');

    // Having accepted terms-v0 does not carry over — a version bump asks
    // again, from unchecked.
    await expect(box).not.toBeChecked();
    await expect(accept).toBeDisabled();

    await box.check();
    await expect(accept).toBeEnabled();
    await accept.click();

    // POST /api/terms-acceptance returns the current versions, the gate
    // clears, and the app mounts behind it.
    await expect(page.locator('#terms-gate-title')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
  });

  test('signing out is the other way past the gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#terms-gate-title')).toBeVisible({ timeout: 20000 });
    await page.locator('.auth-link', { hasText: 'Sign out' }).click();
    await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  });
});

test.describe('the documents themselves', () => {
  test.use({ sessionSeed: false });

  test('render signed out, with no LEGAL REVIEW annotation reaching the page', async ({ page }) => {
    for (const doc of LEGAL_DOCUMENTS) {
      await page.goto(doc.path);
      await expect(page.locator('.legal__h1')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.legal__body')).toContainText(doc.version);
      // The annotations are addressed to a lawyer, not to users. Stripped at
      // build time (dev/legalDocsPlugin.ts) and again at render.
      await expect(page.locator('body')).not.toContainText('LEGAL REVIEW');
      await shot(page, `clickwrap-${doc.slug}-page`);
    }
  });
});
