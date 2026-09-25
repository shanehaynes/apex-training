import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIPS } from '../../src/lib/onboarding/tips/index';

// Profile's three tips (docs/onboarding/workstreams/O14-profile.md), each at
// its real site: the Calendar feed and Claude or ChatGPT folds on first open, and
// coach-goal once a first key save succeeds with the Goal still empty.
//
// TipHost shows one tip per load, and other screens offer theirs too, so
// every test marks the whole catalog seen except the tip it is about. That
// keeps a calendar-screen tip from winning the load before Profile opens.

test.use({ tips: 'on' });

const SEEN_AT = '2026-09-01T00:00:00Z';

/** The fixture's profile row with every tip seen except `unseen`. */
function profileRow(unseen: string, extra: Record<string, unknown> = {}) {
  const tips_seen = Object.fromEntries(TIPS.filter(t => t.id !== unseen).map(t => [t.id, SEEN_AT]));
  return { ...driverProfile(), tips_seen, ...extra };
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

/** GET /api/profile reports no saved key; the PATCH still falls through to the
 *  shared stub, which answers `hasAnthropicKey: true` — a successful save. */
async function stubNoKey(page: Page) {
  await page.route('**/api/profile', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify({
        hasAnthropicKey: false,
        anthropicKeyLast4: null,
        termsAccepted: { termsVersion: 'terms-v1', privacyVersion: 'privacy-v1', acceptedAt: '2026-08-29T00:00:00.000Z' },
        termsCurrent: true,
      }),
    });
  });
}

async function openProfile(page: Page) {
  await gotoCalendar(page);
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
}

const fold = (page: Page, title: string) => page.locator('.profile-fold__toggle', { hasText: title });
const tip = (page: Page, id: string) => page.locator(`.tip[data-tip-id="${id}"]`);

test('opening Calendar feed offers its tip, with the help page behind Show me how', async ({ page }) => {
  await stubProfile(page, profileRow('calendar-feed'));
  await openProfile(page);

  // Merely opening Profile offers nothing: the tip waits for the fold.
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);

  await fold(page, 'Calendar feed').click();
  const card = tip(page, 'calendar-feed');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__link')).toHaveAttribute('href', '/help/calendar-feed');

  await card.locator('.tip__ok').click();
  await expect(page.locator('.tip')).toHaveCount(0);
  // The fold stays open under the card, address and all.
  await expect(page.locator('.profile-feed__url[value*="driver-ics-token"]')).toBeVisible();
});

test('closing Calendar feed before the card lands withdraws it', async ({ page }) => {
  await stubProfile(page, profileRow('calendar-feed'));
  await openProfile(page);
  await fold(page, 'Calendar feed').click();
  await fold(page, 'Calendar feed').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('with Calendar feed seen, opening Claude or ChatGPT offers connector-first', async ({ page }) => {
  await stubProfile(page, profileRow('connector-first'));
  await openProfile(page);

  // Calendar feed is seen: its fold opens quietly.
  await fold(page, 'Calendar feed').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);

  await fold(page, 'Claude or ChatGPT').click();
  const card = tip(page, 'connector-first');
  await expect(card).toBeVisible();
  // No help page: it points at the guide already on screen.
  await expect(card.locator('.tip__link')).toHaveCount(0);
  await expect(card).toContainText('Step-by-step guide');
  await card.locator('.tip__ok').click();
  await expect(page.getByRole('button', { name: 'Step-by-step guide' })).toBeVisible();
});

test('a first key save with no goal offers coach-goal', async ({ page }) => {
  await stubProfile(page, profileRow('coach-goal', { coach_goal: '' }));
  await stubNoKey(page);
  await openProfile(page);

  // No key yet: the key fold opens itself, and nothing is offered.
  const keyInput = page.getByLabel('Anthropic key');
  await expect(keyInput).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);

  await keyInput.fill('sk-ant-test-key-1234');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.locator('.profile-fold__status', { hasText: 'Saved' })).toBeVisible();

  const card = tip(page, 'coach-goal');
  await expect(card).toBeVisible();
  await expect(card.locator('strong', { hasText: 'Goal' })).toBeVisible();
  await card.locator('.tip__ok').click();
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('a first key save with a goal already set offers nothing', async ({ page }) => {
  await stubProfile(page, profileRow('coach-goal', { coach_goal: 'Run a sub-3-hour marathon' }));
  await stubNoKey(page);
  await openProfile(page);

  await page.getByLabel('Anthropic key').fill('sk-ant-test-key-1234');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.locator('.profile-fold__status', { hasText: 'Saved' })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('replacing a saved key is not a first save', async ({ page }) => {
  await stubProfile(page, profileRow('coach-goal', { coach_goal: '' }));
  await openProfile(page);

  await fold(page, 'Anthropic key').click();
  await page.getByRole('button', { name: 'Replace' }).click();
  await page.getByLabel('Anthropic key').fill('sk-ant-test-key-5678');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});
