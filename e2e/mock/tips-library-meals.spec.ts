import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIP_IDS, tipById, type TipId } from '../../src/lib/onboarding/tips/index';

// The library and meal tips (docs/onboarding/workstreams/O12-library-meals.md):
// library-first on the Exercise Library list, meal-first on the first open of
// the Add Meal form. The mechanism itself is tips-core.spec.ts; this spec
// proves the trigger sites.

test.use({ tips: 'on' });

/**
 * Every catalog tip but `id` is already seen, so whichever other features
 * sit mounted underneath (the calendar, once its lane lands) cannot win the
 * one tip this load gets.
 */
async function onlyUnseen(page: Page, id: TipId) {
  const seen = Object.fromEntries(
    TIP_IDS.filter(t => t !== id).map(t => [t, '2026-09-01T00:00:00Z']),
  );
  const row = { ...driverProfile(), tips_seen: seen };
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

function definitionRow(id: string, name: string, category: string, muscles: string[]) {
  return {
    id, user_id: 'driver-user', canonical_name: name, aliases: [], category,
    muscle_groups: muscles, equipment: [], image_url: null, technique_notes: null,
    is_unilateral: false, default_sets: null, default_reps: null, default_duration: null,
    default_weight: null, default_rest: null, archived_at: null,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  };
}

/**
 * The mock harness answers exercise_definitions with [] (library.spec.ts
 * skips for that reason); a list with rows is the state the tip describes.
 */
async function stubDefinitions(page: Page) {
  const rows = [
    definitionRow('def-squat', 'Back Squat', 'strength', ['quads', 'glutes']),
    definitionRow('def-pullup', 'Pull-up', 'strength', ['lats']),
  ];
  await page.route(/\.supabase\.co\/rest\/v1\/exercise_definitions/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify(rows),
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

async function expectTip(page: Page, id: TipId) {
  const card = page.locator(`.tip[data-tip-id="${id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(tipById(id).title);
  await expect(page.locator('.tip'), 'one card at a time').toHaveCount(1);
  return card;
}

async function dismiss(page: Page, id: TipId, patches: Record<string, unknown>[]) {
  await page.locator(`.tip[data-tip-id="${id}"] .tip__ok`).click();
  await expect(page.locator('.tip')).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: id });
}

test('library-first shows over the exercise list and is remembered', async ({ page }) => {
  await onlyUnseen(page, 'library-first');
  await stubDefinitions(page);
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip'), 'nothing on the calendar alone').toHaveCount(0);

  await page.locator('.top-nav button[title="Exercise library"]').click();
  await expect(page.locator('.library-row')).toHaveCount(2);
  // The search no longer grabs focus, so nothing holds the card back.
  await expect(page.locator('.library-search__input')).not.toBeFocused();
  const card = await expectTip(page, 'library-first');
  await expect(card.locator('strong')).toHaveText(['Recent sessions']);
  await shot(page, 'tips-library-first');

  await dismiss(page, 'library-first', patches);
  // The library is still usable underneath.
  await page.locator('.library-row').first().click();
  await expect(page.locator('.library-detail')).toBeVisible();
});

test('library-first waits for the list when a deep link opens a detail', async ({ page }) => {
  await onlyUnseen(page, 'library-first');
  await stubDefinitions(page);
  await gotoCalendar(page);
  await page.locator('.top-nav button[title="Exercise library"]').click();
  // Straight into a detail before the settle ends: the list's tip steps aside.
  await page.locator('.library-row').first().click();
  await expect(page.locator('.library-detail')).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip'), 'no list tip over a detail').toHaveCount(0);

  await page.locator('.library-back').click();
  await expect(page.locator('.library-row').first()).toBeVisible();
  await expectTip(page, 'library-first');
});

test('meal-first shows on the first Add meal from a day', async ({ page }) => {
  await onlyUnseen(page, 'meal-first');
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);

  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await page.locator('.day-modal__add--meal').click();
  await expect(page.locator('.meal-form')).toBeVisible();
  const card = await expectTip(page, 'meal-first');
  await expect(card.locator('strong')).toHaveText(['Save to library']);
  // The label it names is on screen.
  await expect(page.locator('.meal-fav-save')).toHaveText('Save to library');
  await shot(page, 'tips-meal-first');

  await dismiss(page, 'meal-first', patches);
  await page.getByLabel('Title').fill('Oats');
  await expect(page.getByLabel('Title')).toHaveValue('Oats');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  /** The day view renders before the schedule (and so the library) loads. */
  async function gotoDay(page: Page) {
    await page.goto('/');
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
    await expect.poll(
      async () => (await apexState<{ isEventsLoading: boolean }>(page, 'schedule')).isEventsLoading,
      { timeout: 20000 },
    ).toBe(false);
  }

  test('library-first from the top-bar icon', async ({ page }) => {
    await onlyUnseen(page, 'library-first');
    await stubDefinitions(page);
    await gotoDay(page);
    await page.locator('.top-nav button[title="Exercise library"]').click();
    await expect(page.locator('.library-row')).toHaveCount(2);
    await expectTip(page, 'library-first');
    await shot(page, 'tips-library-first-phone');
  });

  test('meal-first from + then Meal', async ({ page }) => {
    await onlyUnseen(page, 'meal-first');
    await gotoDay(page);
    // The "Finish setting up" card sits over the + menu's Meal item on a
    // 375 px phone (outside this lane; reported as a follow-up). Close it.
    await page.locator('.setup-nudge__dismiss').click();
    await expect(page.locator('.setup-nudge')).toHaveCount(0);
    await page.locator('.mobile-nav__add').click();
    await page.getByRole('menuitem', { name: 'Meal' }).click();
    await expect(page.locator('.meal-form')).toBeVisible();
    await expectTip(page, 'meal-first');
    await shot(page, 'tips-meal-first-phone');
  });
});
