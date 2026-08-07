import { test, expect, gotoCalendar, shot, supabaseRef } from '../lib/fixtures';

test('add-meal composer: derived calories, fat-split validation, save', async ({ page }) => {
  await gotoCalendar(page);

  // The day modal offers Add meal next to Add event.
  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await expect(page.locator('.day-modal__add--meal'), 'day modal has an Add meal button').toBeVisible();
  await page.locator('.day-modal__add--meal').click();

  // Full-screen composer, single-phase (no type-picker grid).
  await expect(page.locator('.meal-form')).toBeVisible();
  await expect(page.locator('.composer-type-card')).toHaveCount(0);
  await shot(page, 'meal-composer');

  // Title is required.
  await page.locator('.exercise-editor__save').click();
  await expect(page.getByText('Give the meal a title').first()).toBeVisible();

  await page.getByLabel('Title').fill('Chicken burrito');
  await page.getByLabel('Protein (g)').fill('40');
  await page.getByLabel('Carbs (g)').fill('50');
  await page.getByLabel(/^Total fat/).fill('25');

  // Calories placeholder derives 4/4/9 from the macros: 160 + 200 + 225.
  await expect(page.getByLabel(/^Calories/)).toHaveAttribute('placeholder', '585');

  // Meal-type segmented control toggles.
  await page.locator('.meal-type-row__btn', { hasText: 'Lunch' }).click();
  await expect(page.locator('.meal-type-row__btn--active')).toHaveText('Lunch');

  // A split exceeding the total is rejected (sat 20 + trans 10 > 25).
  await page.getByLabel(/^Saturated fat/).fill('20');
  await page.getByLabel(/^Trans fat/).fill('10');
  await page.locator('.exercise-editor__save').click();
  await expect(page.getByText("Total fat can't be less than saturated + trans").first()).toBeVisible();
  await expect(page.locator('.meal-form'), 'composer stays open on validation failure').toBeVisible();
  await shot(page, 'meal-composer-fat-validation');

  // Fix the split and save. With Supabase, the meal POST is stubbed and the
  // composer closes; offline createMeal returns null → failure toast, stays open.
  await page.getByLabel(/^Trans fat/).fill('2');
  await page.locator('.exercise-editor__save').click();
  const seedMode = supabaseRef() === null;
  if (seedMode) {
    await expect(page.locator('.composer-view'), 'composer stays open when the save fails').toBeVisible();
    await expect(page.getByText('Failed to save').first(), 'seed-mode save surfaces the failure toast').toBeVisible();
  } else {
    await expect(page.locator('.composer-view'), 'composer closes after a successful save').toHaveCount(0);
    // The optimistic append surfaces the meal (and the totals strip) in the day modal.
    await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
    await expect(page.locator('.day-modal__meal-title')).toHaveText('Chicken burrito');
    await expect(page.locator('.day-modal__macros')).toBeVisible();
    await expect(page.locator('.day-modal__count')).toContainText('1 meal');
    await shot(page, 'day-modal-with-meal');
  }
  await shot(page, 'meal-composer-saved');
});
