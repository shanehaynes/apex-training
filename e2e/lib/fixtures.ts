// Playwright fixtures for the mock project: every test gets the interception
// layer (no request can mutate real data), the fabricated auth session when
// .env.local carries Supabase creds, and an automatic no-console-errors
// assertion at teardown.

import { test as base, expect, type Page } from '@playwright/test';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { installIntercept } from './intercept.mjs';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { readSupabaseEnv, seedFabricatedSession, driverProfile } from './session.mjs';

interface ApexOptions {
  /** Seed the fabricated Supabase session before load (no-op offline). */
  sessionSeed: boolean;
  /** Stub the profile as a fresh account so the template banner renders. */
  freshProfile: boolean;
  /** Freeze the app's date-semantic clock (see src/lib/clock.ts), e.g. '2026-03-02T08:00:00'. */
  fakeNow: string | null;
}

interface ApexFixtures {
  consoleErrors: string[];
  /** Supabase project ref from .env.local, or null in offline mode. */
  supabaseRef: string | null;
}

export const test = base.extend<ApexOptions & ApexFixtures>({
  sessionSeed: [true, { option: true }],
  freshProfile: [false, { option: true }],
  fakeNow: [null, { option: true }],

  supabaseRef: async ({}, use) => {
    await use(readSupabaseEnv().ref);
  },

  context: async ({ context, sessionSeed, freshProfile, fakeNow }, use) => {
    const { ref, anonKey } = readSupabaseEnv();
    await installIntercept(context, { anonKey, profile: driverProfile({ fresh: freshProfile }) });
    if (ref && sessionSeed) await seedFabricatedSession(context, ref);
    if (fakeNow) {
      await context.addInitScript(v => {
        (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
      }, fakeNow);
    }
    await use(context);
  },

  consoleErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await use(errors);
    expect.soft(errors, 'no console errors during the test').toEqual([]);
  }, { auto: true }],
});

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
