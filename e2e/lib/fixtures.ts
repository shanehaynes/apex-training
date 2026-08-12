// Playwright fixtures for the mock project: every test gets the interception
// layer (no request can mutate real data), a fabricated auth session against
// the pinned fake project, and an automatic no-console-errors assertion at
// teardown.
//
// The session used to depend on .env.local, which made the suite behave
// differently for a developer who had one than for CI, which does not — see
// MOCK_SUPABASE in session.mjs.

import { test as base, expect, type Page } from '@playwright/test';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { installIntercept, isExpectedConsoleError } from './intercept.mjs';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { MOCK_SUPABASE, seedFabricatedSession, driverProfile } from './session.mjs';

export interface ApexOptions {
  /** Seed the fabricated Supabase session before load (no-op offline). */
  sessionSeed: boolean;
  /** Stub the profile as a fresh account so the template banner renders. */
  freshProfile: boolean;
  /**
   * Freeze the app's date-semantic clock (see src/lib/clock.ts), e.g.
   * '2026-03-02T08:00:00'. The mock project pins a default in
   * playwright.config.ts — the bundled seed only covers 2026-06-22 through
   * 2027-05-31, so specs reading the real clock would start failing the day
   * it passes the seed's end. Specs still override per-test via test.use().
   */
  fakeNow: string | null;
}

interface ApexFixtures {
  consoleErrors: string[];
}

export const test = base.extend<ApexOptions & ApexFixtures>({
  sessionSeed: [true, { option: true }],
  freshProfile: [false, { option: true }],
  fakeNow: [null, { option: true }],

  // Note: the second fixture argument is Playwright's `use` continuation —
  // named `provide` here so lint doesn't mistake it for a React hook.
  context: async ({ context, sessionSeed, freshProfile, fakeNow }, provide) => {
    // Pinned, not read from .env.local: specs that need an authenticated app
    // (the profile-driven onboarding flow) would otherwise pass for whoever
    // has a .env.local and fail in CI, which has none.
    const { ref, anonKey } = MOCK_SUPABASE;
    await installIntercept(context, { anonKey, profile: driverProfile({ fresh: freshProfile }) });
    if (sessionSeed) await seedFabricatedSession(context, ref);
    if (fakeNow) {
      await context.addInitScript(v => {
        (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
      }, fakeNow);
    }
    await provide(context);
  },

  consoleErrors: [async ({ page }, provide) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !isExpectedConsoleError(msg)) errors.push(msg.text());
    });
    await provide(errors);
    expect.soft(errors, 'no console errors during the test').toEqual([]);
  }, { auto: true }],
});

/**
 * The project ref the mock app is signed in against — now always the pinned
 * fake one, never null. Specs use this to branch between signed-in and
 * offline seed behavior; it used to depend on whether the developer had a
 * .env.local, so the same spec took a different branch locally than in CI.
 */
export function supabaseRef(): string | null {
  return MOCK_SUPABASE.ref;
}

export { expect };

/** Read a dev-bridge snapshot (see src/dev/agentBridge.ts). */
export async function apexState<T = Record<string, unknown>>(page: Page, key?: string): Promise<T> {
  return await page.evaluate(
    k => (window as unknown as { __apex?: { state(k?: string): unknown } }).__apex?.state(k),
    key,
  ) as T;
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `e2e/screenshots/${name}.png` });
}

/** Load the app and wait for the calendar (works signed-in and offline). */
export async function gotoCalendar(page: Page) {
  await page.goto('/');
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
}
