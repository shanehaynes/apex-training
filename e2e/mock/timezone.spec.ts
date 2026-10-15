import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';

// The web writes the browser's time zone to profiles.timezone (phase58) so
// the server's browserless paths — MCP calls without `today`, the nightly
// reflection, the provider cron — compute "today" where the athlete is.

test.use({ timezoneId: 'America/Chicago' });

/** Answer the own-profile read with this row instead of the fixture's. */
async function stubProfile(page: Page, row: Record<string, unknown>) {
  await page.route(/\.supabase\.co\/rest\/v1\/profiles/, route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify(wantsObject ? row : [row]),
    });
  });
}

/** Every PATCH /api/profile body the page sends that carries a timezone. */
function recordTimezonePatches(page: Page): unknown[] {
  const sent: unknown[] = [];
  page.on('request', req => {
    if (req.method() !== 'PATCH' || !req.url().includes('/api/profile')) return;
    const body = req.postDataJSON() as Record<string, unknown> | null;
    if (body && 'timezone' in body) sent.push(body.timezone);
  });
  return sent;
}

test('a browser in a different zone writes it to the profile, once', async ({ page }) => {
  const sent = recordTimezonePatches(page);
  await stubProfile(page, { ...driverProfile(), timezone: 'UTC' });
  await gotoCalendar(page);
  await expect.poll(() => sent).toEqual(['America/Chicago']);
  // The optimistic record after the 200 stops a second write in this load.
  await page.waitForTimeout(500);
  expect(sent).toEqual(['America/Chicago']);
});

test('a stored zone that matches the browser sends nothing', async ({ page }) => {
  const sent = recordTimezonePatches(page);
  await stubProfile(page, { ...driverProfile(), timezone: 'America/Chicago' });
  await gotoCalendar(page);
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
});

test('before phase58 reaches the database, nothing is sent', async ({ page }) => {
  const sent = recordTimezonePatches(page);
  // driverProfile carries no timezone key: the pre-migration row shape.
  await gotoCalendar(page);
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
});

test.describe('with terms to accept', () => {
  test.use({ staleTerms: true });

  test('waits for the acceptance, then writes the zone', async ({ page }) => {
    const sent = recordTimezonePatches(page);
    await stubProfile(page, { ...driverProfile(), timezone: null });
    await page.goto('/');
    const box = page.locator('#accept-legal-gate');
    await expect(box).toBeVisible({ timeout: 20000 });
    expect(sent, 'every gated route 403s until the terms are accepted').toEqual([]);
    await box.check();
    await page.locator('.welcome__action').click();
    await expect.poll(() => sent).toEqual(['America/Chicago']);
  });
});
