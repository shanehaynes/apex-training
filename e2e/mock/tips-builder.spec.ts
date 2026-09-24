import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIP_IDS, tipById, type TipId } from '../../src/lib/onboarding/tips/index';

// The builder's first-open tips (docs/onboarding/workstreams/O11-builder.md):
// Add → builder-search-first, the form's repeat picker → builder-repeat, the
// ✨ button → builder-coach. TipHost shows one tip per load, so each test
// serves a profile on which every OTHER tip is already seen — the calendar a
// test passes through on its way to the builder can then never spend the
// load's one tip first.

test.use({ tips: 'on' });

/** Answer the own-profile read with a row that has seen every tip but `id`. */
async function onlyUnseen(page: Page, id: TipId) {
  const tips_seen = Object.fromEntries(
    TIP_IDS.filter(t => t !== id).map(t => [t, '2026-09-01T00:00:00Z']),
  );
  const row = { ...driverProfile(), tips_seen };
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

function tip(page: Page, id: TipId) {
  return page.locator(`.tip[data-tip-id="${id}"]`);
}

async function openAdd(page: Page) {
  await gotoCalendar(page);
  await page.getByTestId('nav-add-workout').click();
  await expect(page.locator('.builder-search')).toBeVisible();
}

test('Add offers builder-search-first on the search step', async ({ page }) => {
  await onlyUnseen(page, 'builder-search-first');
  await openAdd(page);

  // An empty library has nothing to search, so the box does not take focus —
  // which is also what lets the tip land (TipHost waits while an input has it).
  await expect(page.locator('.library-search__input')).not.toBeFocused();

  const card = tip(page, 'builder-search-first');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(tipById('builder-search-first').title);
  await expect(card.locator('.tip__link')).toHaveCount(0);
  await expect(page.locator('.builder-search__create')).toHaveText(/Build a new workout/);
  await shot(page, 'tips-builder-search-first');

  await card.locator('.tip__ok').click();
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('Build a new workout offers builder-repeat once search-first is seen', async ({ page }) => {
  await onlyUnseen(page, 'builder-repeat');
  await openAdd(page);
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip'), 'search-first is seen: nothing on the search step').toHaveCount(0);

  await page.locator('.builder-search__create').click();
  await expect(page.locator('.builder-repeat')).toBeVisible();
  const card = tip(page, 'builder-repeat');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__link')).toHaveAttribute('href', '/help/repeating-workouts');
  await shot(page, 'tips-builder-repeat');

  await card.locator('.tip__ok').click();
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('the ✨ button offers builder-coach', async ({ page }) => {
  await onlyUnseen(page, 'builder-coach');
  await openAdd(page);
  await page.locator('.builder-search__create').click();
  await expect(page.locator('.builder-repeat')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip'), 'nothing before the coach is opened').toHaveCount(0);

  await page.getByRole('button', { name: 'Show coach' }).click();
  await expect(page.locator('.builder-coach')).toBeVisible();
  const card = tip(page, 'builder-coach');
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__link')).toHaveAttribute('href', '/help/get-api-key');
  await shot(page, 'tips-builder-coach');

  await card.locator('.tip__ok').click();
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('editing an existing workout does not offer builder-search-first', async ({ page }) => {
  await onlyUnseen(page, 'builder-search-first');
  await gotoCalendar(page);
  const schedule = await apexState<{ events: Array<{ title: string; isRecurring: boolean }> }>(page, 'schedule');
  const oneOff = schedule.events.find(e => !e.isRecurring)!;
  await page.locator('.event-chip__main', { hasText: oneOff.title }).first().click();
  await page.locator('.modal-edit-workout').click();
  await expect(page.locator('.composer-form')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('+ → Workout offers builder-search-first', async ({ page }) => {
    await onlyUnseen(page, 'builder-search-first');
    await page.goto('/');
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
    // The setup nudge sits over the + menu's items at this size (outside this
    // lane; reported). Close it so the tap reaches Workout.
    await page.locator('.setup-nudge__dismiss').click();
    await page.locator('.mobile-nav__add').click();
    await page.getByRole('menuitem', { name: 'Workout' }).click();
    await expect(page.locator('.builder-search')).toBeVisible();

    const card = tip(page, 'builder-search-first');
    await expect(card).toBeVisible();
    await shot(page, 'tips-builder-search-first-phone');
    await card.locator('.tip__ok').click();
    await expect(page.locator('.tip')).toHaveCount(0);
  });
});
