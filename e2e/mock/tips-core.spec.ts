import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIPS, type TipDefinition } from '../../src/lib/onboarding/tips/index';

// The tips mechanism end to end (docs/onboarding/workstreams/O03-tips-core.md):
// one card per load, never over the welcome flow, "seen" remembered on the
// server when profiles.tips_seen exists and on the device always.
//
// TipHost's e2e hook stands in for a feature's useTip: window.__APEX_TIPS_DEMO__
// = true offers the catalog's first tip, or a tip id offers that one. Real
// features call useTip too (the calendar under every screen offers its own),
// so demo() also serves a profile where every other catalog tip is already
// seen — the demo tip is then the only candidate, whatever wave 2 adds. Every
// other spec runs with tips 'off' (fixtures.ts).

test.use({ freshProfile: true, tips: 'on' });

const CATALOG: readonly TipDefinition[] = TIPS;
const FIRST = CATALOG[0];
const WITH_HELP = CATALOG.find(t => t.help)!;
const WITHOUT_HELP = CATALOG.find(t => !t.help)!;

/** A tips_seen map with every catalog tip except `id` marked seen. */
function seenExcept(id: string): Record<string, string> {
  return Object.fromEntries(CATALOG.filter(t => t.id !== id).map(t => [t.id, '2026-09-01T00:00:00Z']));
}

/**
 * Offer a tip on every load of this page, as a feature's useTip would, and
 * keep every other tip out of the one slot. A test that stubs the profile
 * itself afterwards wins: Playwright matches the newest route first.
 */
async function demo(page: Page, id: string | true = true) {
  const tipId = id === true ? FIRST.id : id;
  await stubProfile(page, { ...driverProfile({ fresh: true }), tips_seen: seenExcept(tipId) });
  await page.addInitScript(v => {
    (window as unknown as { __APEX_TIPS_DEMO__?: string | boolean }).__APEX_TIPS_DEMO__ = v;
  }, id);
}

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

/** Every PATCH /api/profile body the page sends. */
function recordProfilePatches(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', req => {
    if (req.method() === 'PATCH' && req.url().includes('/api/profile')) {
      bodies.push(req.postDataJSON() as Record<string, unknown>);
    }
  });
  return bodies;
}

async function skipWelcome(page: Page) {
  await page.locator('.welcome__skip').click();
  await expect(page.locator('.welcome')).toHaveCount(0);
}

test('one tip per load, never over the welcome flow, and Got it is remembered', async ({ page }) => {
  await demo(page);
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);

  // The welcome flow is up and the tip is already on offer: it must wait.
  await expect(page.locator('.welcome')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip'), 'no tip while the intro is up').toHaveCount(0);

  await skipWelcome(page);
  const card = page.locator('.tip');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-tip-id', FIRST.id);
  await expect(card.locator('.tip__title')).toHaveText(FIRST.title);
  await expect(card.getByRole('button', { name: 'Got it' })).toBeFocused();
  await expect(page.getByRole('dialog', { name: FIRST.title })).toBeVisible();

  // Escape does nothing.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(1);

  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: FIRST.id });

  // Still on offer, but one per load: nothing else comes, here or in Profile.
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('a tip the server says is seen stays gone on reload', async ({ page }) => {
  await demo(page);
  await stubProfile(page, {
    ...driverProfile(), tips_seen: { [FIRST.id]: '2026-09-01T00:00:00Z' },
  });
  await gotoCalendar(page);
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('before the column exists: no request, and the device remembers', async ({ page }) => {
  await demo(page);
  // The pre-migration row: select('*') has no tips_seen key at all.
  const { tips_seen: _absent, ...legacy } = driverProfile();
  await stubProfile(page, legacy);
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);

  const card = page.locator('.tip');
  await expect(card).toHaveCount(1);
  // Backdrop tap is Got it.
  await page.locator('.modal-backdrop--tip').click({ position: { x: 5, y: 5 } });
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await expect(card, 'localStorage carried it across the reload').toHaveCount(0);
  expect(patches.filter(b => 'tip_seen' in b), 'nothing to PATCH without the column').toEqual([]);
});

test('Show me how opens the help page in a new tab and counts as seen', async ({ page, context }) => {
  await demo(page, WITH_HELP.id);
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);
  await skipWelcome(page);

  const card = page.locator('.tip');
  await expect(card).toHaveAttribute('data-tip-id', WITH_HELP.id);
  const link = card.getByRole('link', { name: 'Show me how' });
  await expect(link).toHaveAttribute('target', '_blank');

  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).pathname).toBe(`/help/${WITH_HELP.help}`);
  await popup.close();

  await expect(card).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: WITH_HELP.id });
});

test('a tip without a help page has no Show me how', async ({ page }) => {
  await demo(page, WITHOUT_HELP.id);
  await gotoCalendar(page);
  await skipWelcome(page);
  await expect(page.locator('.tip')).toHaveAttribute('data-tip-id', WITHOUT_HELP.id);
  await expect(page.locator('.tip').getByRole('link')).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the card is a sheet that stops above the tab bar', async ({ page }) => {
    await demo(page);
    await page.goto('/');
    await page.locator('.welcome__skip').click({ timeout: 20000 });

    const card = page.locator('.tip');
    await expect(card).toBeVisible();
    await expect(page.locator('.mobile-nav')).toBeVisible();
    // Let the entrance animation land before measuring.
    await page.waitForTimeout(400);
    const cardBox = await card.boundingBox();
    const navBox = await page.locator('.mobile-nav').boundingBox();
    expect(cardBox!.y + cardBox!.height, 'card bottom clears the tab bar').toBeLessThanOrEqual(navBox!.y);
    expect(cardBox!.x).toBeGreaterThanOrEqual(0);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(375);
    await shot(page, 'tips-core-phone');
  });

  // A short visual viewport is what an open on-screen keyboard looks like.
  test('waits while the viewport is short, then shows once it grows', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 460 });
    await demo(page);
    await page.goto('/');
    await page.locator('.welcome__skip').click({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await expect(page.locator('.tip'), 'deferred while the keyboard would be up').toHaveCount(0);

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('.tip')).toBeVisible();
  });
});

test.describe('tips off (every other spec)', () => {
  test.use({ tips: 'off' });

  test('the kill switch shows nothing', async ({ page }) => {
    await demo(page);
    await gotoCalendar(page);
    await skipWelcome(page);
    await page.waitForTimeout(1200);
    await expect(page.locator('.tip')).toHaveCount(0);
  });
});
