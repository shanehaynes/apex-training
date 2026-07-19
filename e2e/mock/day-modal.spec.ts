import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

test('day modal, composer flow, and pre-filtered exercise picker', async ({ page }) => {
  await gotoCalendar(page);

  // Day-number click on a cell that has events opens the day overview modal.
  const dayBtn = page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first();
  await dayBtn.click();
  await expect(page.locator('.day-modal__event').first()).toBeVisible();
  await expect(page.locator('.day-modal__date'), 'day modal header shows the date').toBeVisible();
  await expect(page.locator('.day-modal__add'), 'day modal has an Add event button').toBeVisible();
  await shot(page, 'day-modal');

  // Clicking an event row replaces the day modal with the workout modal.
  await page.locator('.day-modal__event').first().click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();
  await expect(page.locator('.day-modal__list'), 'day modal closes when an event is selected').toHaveCount(0);
  await shot(page, 'day-modal-event-opened');
  await page.keyboard.press('Escape');

  // Reopen and go to the add-event composer.
  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await page.locator('.day-modal__add').click();
  await expect(page.locator('.composer-type-card')).toHaveCount(7);
  await shot(page, 'composer-types');

  // Pick Strength → details form with the exercise sections.
  await page.locator('.composer-type-card', { hasText: 'Strength' }).click();
  await expect(page.locator('.composer-form')).toBeVisible();
  await shot(page, 'composer-form');

  // The picker opens pre-filtered to the type's aligned category.
  await page.locator('.exercise-editor__add').first().click();
  await expect(page.locator('.exercise-picker__filters')).toBeVisible();
  await expect(page.locator('.exercise-picker__filters .library-filter--active')).toHaveText('Strength');
  const categories = await page.locator('.exercise-picker__row .library-row__category').allTextContents();
  expect(categories.every(c => c === 'strength'), 'filtered picker rows are all strength').toBe(true);
  await shot(page, 'composer-picker');

  // Clearing to "All" surfaces the whole library. Without Supabase-backed
  // definitions the library is empty — skip the pick, keep the save check.
  await page.locator('.exercise-picker__filters .library-filter', { hasText: /^All$/ }).click();
  const rows = page.locator('.exercise-picker__row');
  const seedMode = (await rows.count()) === 0;
  if (!seedMode) {
    const pickedName = await page.locator('.exercise-picker__row-name').first().textContent();
    await rows.first().click();
    await expect(page.locator('.composer-exercises')).toContainText(pickedName!);
    await shot(page, 'composer-with-exercise');
  } else {
    await page.keyboard.press('Escape');
  }

  // Save. With Supabase, POST /api/events is stubbed and the composer
  // closes; in seed mode createEvent returns null → failure toast, stays open.
  await page.locator('.exercise-editor__save').click();
  if (seedMode) {
    await expect(page.locator('.composer-view'), 'composer stays open when the save fails').toBeVisible();
    await expect(page.getByText('Failed to save').first(), 'seed-mode save surfaces the failure toast').toBeVisible();
  } else {
    await expect(page.locator('.composer-view'), 'composer closes after a successful save').toHaveCount(0);
  }
  await shot(page, 'composer-saved');
});
