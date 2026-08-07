// Live meal logging: the add-meal composer writes through the meals API into
// local Postgres, the day modal lists the meal with the daily totals strip,
// and delete removes the row. Mirrors live.spec.ts's structure.

import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../scripts/lib/localEnv.mjs';

const env = localSupabaseEnv();
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

const FAKE_NOW = '2026-08-03T08:00:00';

async function signIn(page: Page, email: string) {
  await page.addInitScript(v => {
    (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
  }, FAKE_NOW);
  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill('apex-agent-password');
  await page.locator('.auth-submit').click();
}

// Meals are run artifacts, not fixture data — start pristine.
test.beforeAll(async () => {
  await admin.from('meals').delete().gte('date', '1900-01-01');
  await admin.from('meal_mutations_log').delete().gte('logged_at', '1900-01-01');
  await admin.from('meal_favorites').delete().gte('created_at', '1900-01-01');
});

test('a meal saves through the API, renders in the day modal, edits in place, and deletes', async ({ page }) => {
  await signIn(page, 'agent@apex.local');
  await expect(page.locator('.event-chip__main').first()).toBeVisible({ timeout: 20000 });

  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await page.locator('.day-modal__add--meal').click();
  await expect(page.locator('.meal-form')).toBeVisible();

  await page.getByLabel('Title').fill('Live burrito');
  await page.locator('.meal-type-row__btn', { hasText: 'Lunch' }).click();
  await page.getByLabel('Protein (g)').fill('40');
  await page.getByLabel('Carbs (g)').fill('50');
  await page.getByLabel(/^Total fat/).fill('25');
  await page.getByLabel(/^Saturated fat/).fill('9');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view'), 'composer closes after save').toHaveCount(0);

  // The row landed in Postgres with the JWT-stamped owner and mapped columns.
  const { data: rows } = await admin.from('meals').select('*').eq('title', 'Live burrito');
  expect(rows).toHaveLength(1);
  expect(rows![0].meal_type).toBe('lunch');
  expect(Number(rows![0].protein_g)).toBe(40);
  expect(Number(rows![0].fat_saturated_g)).toBe(9);
  expect(rows![0].calories).toBeNull();
  expect(rows![0].user_id).toBeTruthy();

  // Reopened day modal lists the meal with derived calories and the totals strip.
  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await expect(page.locator('.day-modal__meal-title')).toHaveText('Live burrito');
  await expect(page.locator('.day-modal__count')).toContainText('1 meal');
  await expect(page.locator('.day-modal__meal-macros')).toContainText('585 kcal');
  await expect(page.locator('.day-modal__macros')).toContainText('585');
  await page.screenshot({ path: 'e2e/screenshots/day-modal-with-meal-live.png' });

  // The other seeded user must not see it (RLS scoping).
  const { data: crossCheck } = await admin
    .from('meals')
    .select('user_id')
    .eq('title', 'Live burrito')
    .single();
  const { data: agent2 } = await admin.auth.admin.listUsers();
  const otherId = agent2.users.find(u => u.email === 'agent2@apex.local')?.id;
  expect(crossCheck!.user_id).not.toBe(otherId);

  // Clicking the meal row opens the composer in edit mode, prefilled.
  await page.locator('.day-modal__meal-main').click();
  await expect(page.locator('.library-header__title')).toHaveText('Edit Meal');
  await expect(page.getByLabel('Title')).toHaveValue('Live burrito');
  await expect(page.getByLabel('Protein (g)')).toHaveValue('40');
  await expect(page.locator('.meal-type-row__btn--active')).toHaveText('Lunch');
  await page.screenshot({ path: 'e2e/screenshots/meal-editor-live.png' });

  // Change one field, clear another — both must persist (blank = column null).
  await page.getByLabel('Protein (g)').fill('45');
  await page.getByLabel(/^Saturated fat/).fill('');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  const { data: edited } = await admin.from('meals').select('*').eq('title', 'Live burrito');
  expect(Number(edited![0].protein_g)).toBe(45);
  expect(edited![0].fat_saturated_g).toBeNull();

  // The reopened day modal reflects the edit (605 = 4·45 + 4·50 + 9·25).
  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await expect(page.locator('.day-modal__meal-macros')).toContainText('605 kcal · P 45');

  // Delete from the day modal removes the row.
  await page.locator('.day-modal__meal-delete').click();
  await expect(page.locator('.day-modal__meal')).toHaveCount(0);
  await expect.poll(async () => {
    const { data } = await admin.from('meals').select('id').eq('title', 'Live burrito');
    return data?.length ?? -1;
  }).toBe(0);

  // Every mutation left a user-attributed audit row (the AI cap counts these).
  await expect.poll(async () => {
    const { data } = await admin
      .from('meal_mutations_log')
      .select('operation, triggered_by')
      .order('logged_at');
    return data?.map(r => `${r.operation}:${r.triggered_by}`) ?? [];
  }).toEqual(['create:user', 'update:user', 'delete:user']);

  // ── Favorites: save to library, upsert on re-save, fill from chip, remove ──

  await page.locator('.day-modal__add--meal').click();
  await page.getByLabel('Title').fill('Fav bowl');
  await page.locator('.meal-type-row__btn', { hasText: 'Breakfast' }).click();
  await page.getByLabel('Protein (g)').fill('33');
  await page.getByLabel('Carbs (g)').fill('40');
  await page.getByLabel(/^Total fat/).fill('12');
  await page.locator('.meal-fav-save').click();
  await expect(page.getByText('Saved to library').first()).toBeVisible();

  const { data: favs } = await admin.from('meal_favorites').select('*');
  expect(favs).toHaveLength(1);
  expect(favs![0].title).toBe('Fav bowl');
  expect(Number(favs![0].protein_g)).toBe(33);

  // Re-saving the same title overwrites — no duplicate rows.
  await page.getByLabel('Protein (g)').fill('35');
  await page.locator('.meal-fav-save').click();
  await expect(page.getByText('Library favorite updated').first()).toBeVisible();
  await expect.poll(async () => {
    const { data } = await admin.from('meal_favorites').select('protein_g');
    return data?.map(r => Number(r.protein_g)) ?? [];
  }).toEqual([35]);

  // A fresh composer offers the chip; tapping it fills the whole form.
  await page.locator('.exercise-editor__cancel').click();
  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await page.locator('.day-modal__add--meal').click();
  await expect(page.getByLabel('Title')).toHaveValue('');
  await page.locator('.meal-fav-chip__apply', { hasText: 'Fav bowl' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Fav bowl');
  await expect(page.getByLabel('Protein (g)')).toHaveValue('35');
  await expect(page.getByLabel(/^Total fat/)).toHaveValue('12');
  await expect(page.locator('.meal-type-row__btn--active')).toHaveText('Breakfast');
  await page.screenshot({ path: 'e2e/screenshots/meal-favorites-live.png' });

  // Removing the chip deletes the favorite.
  await page.locator('.meal-fav-chip__remove').click();
  await expect(page.locator('.meal-fav-chip')).toHaveCount(0);
  await expect.poll(async () => {
    const { data } = await admin.from('meal_favorites').select('id');
    return data?.length ?? -1;
  }).toBe(0);
});
