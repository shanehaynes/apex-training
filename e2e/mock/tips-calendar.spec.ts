import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIPS, tipById } from '../../src/lib/onboarding/tips/index';

// The calendar's two tips (docs/onboarding/workstreams/O07-calendar.md):
// day-complete-circle the first time a workout with a complete circle is on
// screen, template-copied on the first calendar mount after this device
// copied the starter plan. Each once; neither back after Got it.

test.use({ tips: 'on' });

const DAY = tipById('day-complete-circle');
const COPIED = tipById('template-copied');

const tip = (page: Page) => page.locator('.tip');

// Every other lane's tip is live on the calendar too (the coach's priority-0
// coach-first-message wins a desktop load with a key), so the profile marks
// all of them seen and only this lane's two are left to compete. Built from
// the catalog so a tip added later stays out of the way.
const CALENDAR_IDS: readonly string[] = [DAY.id, COPIED.id];
const OTHER_LANES_SEEN = Object.fromEntries(
  TIPS.filter(t => !CALENDAR_IDS.includes(t.id)).map(t => [t.id, '2026-09-01T00:00:00Z']),
);

/** Answer the own-profile read with `row()` (read per request), other lanes' tips seen. */
async function stubProfile(page: Page, row: () => Record<string, unknown>) {
  await page.route(/\.supabase\.co\/rest\/v1\/profiles/, route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const base = row();
    const body = { ...base, tips_seen: { ...(base.tips_seen as Record<string, string> | undefined), ...OTHER_LANES_SEEN } };
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify(wantsObject ? body : [body]),
    });
  });
}

/** Nothing lands within a generous settle. */
async function expectNoTip(page: Page, why: string) {
  await page.waitForTimeout(1200);
  await expect(tip(page), why).toHaveCount(0);
}

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the day view offers the complete circle once', async ({ page }) => {
    await stubProfile(page, () => driverProfile());
    await page.goto('/');
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.day-event-card').first()).toBeVisible({ timeout: 20000 });

    const card = page.locator(`.tip[data-tip-id="${DAY.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.tip__title')).toHaveText(DAY.title);
    await expect(card.locator('.tip__link'), 'no help page for this one').toHaveCount(0);
    await card.locator('.tip__ok').click();
    await expect(tip(page)).toHaveCount(0);

    // Seen stays seen, and a plan copied long ago (the settled profile's
    // template_copied_at) is no reason to announce it.
    await page.reload();
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
    await expectNoTip(page, 'neither calendar tip comes back');
  });
});

test('desktop: the month grid offers the complete circle once', async ({ page }) => {
  await stubProfile(page, () => driverProfile());
  await gotoCalendar(page);
  const card = page.locator(`.tip[data-tip-id="${DAY.id}"]`);
  await expect(card).toBeVisible();
  await card.locator('.tip__ok').click();
  await expect(tip(page)).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
  await expectNoTip(page, 'seen on this device');
});

test.describe('fresh account', () => {
  test.use({ freshProfile: true });

  test('copying the starter plan earns template-copied on the next load', async ({ page }) => {
    // Three full loads of the calendar, each parsing the bundled seed.
    test.setTimeout(90_000);
    // A server of two facts: the copy stamps template_copied_at, finishing
    // the welcome flow stamps onboarding_dismissed_at. The own-profile read
    // reports both, as the real one would after a reload.
    const server = { copiedAt: null as string | null, dismissedAt: null as string | null };
    page.on('request', req => {
      if (req.method() === 'PATCH' && req.url().includes('/api/profile')
        && (req.postDataJSON() as Record<string, unknown>)?.onboarding_dismissed) {
        server.dismissedAt ??= '2026-09-07T08:00:00Z';
      }
    });
    await page.route('**/api/template-copy', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      server.copiedAt = '2026-09-07T08:00:00Z';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: 7, alreadyCopied: false }),
      });
    });
    await stubProfile(page, () => ({
      ...driverProfile({ fresh: true }),
      template_copied_at: server.copiedAt,
      onboarding_dismissed_at: server.dismissedAt,
    }));

    await gotoCalendar(page);
    const welcome = page.locator('.welcome');
    await expect(welcome).toBeVisible();
    await welcome.locator('.welcome__next').click();
    await welcome.getByRole('button', { name: 'Copy the starter plan' }).click();
    await expect(page.getByText('Added 7 recurring workouts')).toBeVisible({ timeout: 20000 });
    await page.locator('.welcome__skip').click();
    await expect(welcome).toHaveCount(0);

    // Same load: the calendar under the welcome flow was mounted before the
    // copy, so the circle tip is the one offered — one card per load.
    const dayCard = page.locator(`.tip[data-tip-id="${DAY.id}"]`);
    await expect(dayCard).toBeVisible();
    await dayCard.locator('.tip__ok').click();
    await expect(tip(page)).toHaveCount(0);

    // Next load: the plan is announced, with its help page.
    await page.reload();
    await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
    const copiedCard = page.locator(`.tip[data-tip-id="${COPIED.id}"]`);
    await expect(copiedCard).toBeVisible();
    await expect(copiedCard.locator('.tip__title')).toHaveText(COPIED.title);
    await expect(copiedCard.locator('.tip__text strong')).toHaveText(['Delete workout', 'This day only', 'Whole series']);
    await expect(copiedCard.locator('.tip__link')).toHaveAttribute('href', `/help/${COPIED.help}`);
    await copiedCard.locator('.tip__ok').click();
    await expect(tip(page)).toHaveCount(0);

    // And never again; the device's "copied here" marker is gone with it.
    await page.reload();
    await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
    await expectNoTip(page, 'both calendar tips are seen');
    const markers = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('apex:template-copied-here:')));
    expect(markers).toEqual([]);
  });
});
