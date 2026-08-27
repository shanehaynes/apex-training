import { test, expect, gotoCalendar, shot, supabaseRef } from '../lib/fixtures';

test('day modal, builder flow, and pre-filtered exercise picker', async ({ page }) => {
  await gotoCalendar(page);

  // Day-number click on a cell that has events opens the day overview modal.
  const dayBtn = page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first();
  await dayBtn.click();
  await expect(page.locator('.day-modal__event').first()).toBeVisible();
  await expect(page.locator('.day-modal__date'), 'day modal header shows the date').toBeVisible();
  await expect(page.locator('.day-modal__add', { hasText: 'Add event' }), 'day modal has an Add event button').toBeVisible();
  await shot(page, 'day-modal');

  // Clicking an event row replaces the day modal with the workout modal.
  await page.locator('.day-modal__event').first().click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();
  await expect(page.locator('.day-modal__list'), 'day modal closes when an event is selected').toHaveCount(0);
  await shot(page, 'day-modal-event-opened');
  await page.keyboard.press('Escape');

  // Reopen and go to the workout builder — search-first over the library.
  await page.locator('.day-cell:has(.event-chip) .day-cell__date-btn').first().click();
  await page.locator('.day-modal__add', { hasText: 'Add event' }).click();
  await expect(page.locator('.builder-search')).toBeVisible();
  await shot(page, 'builder-search');

  // Create new → the form, defaulting to Strength with all 7 category chips.
  await page.locator('.builder-search__create').click();
  await expect(page.locator('.composer-form')).toBeVisible();
  await expect(page.locator('.builder-type-chip')).toHaveCount(7);
  await expect(page.locator('.builder-type-chip--active')).toHaveText(/Strength/);
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill('Day Modal Spec');
  await shot(page, 'builder-form');

  // The picker opens pre-filtered to the type's aligned category.
  await page.locator('.exercise-editor__add').first().click();
  await expect(page.locator('.exercise-picker__filters')).toBeVisible();
  await expect(page.locator('.exercise-picker__filters .library-filter--active')).toHaveText('Strength');
  const categories = await page.locator('.exercise-picker__row .library-row__category').allTextContents();
  expect(categories.every(c => c === 'strength'), 'filtered picker rows are all strength').toBe(true);
  await shot(page, 'composer-picker');

  // Clearing to "All" surfaces the whole library. The intercept stubs
  // exercise_definitions as empty, so the library is empty in both modes —
  // skip the pick, keep the save check. (Guarded rather than removed in case
  // the stub grows deterministic rows later.)
  await page.locator('.exercise-picker__filters .library-filter', { hasText: /^All$/ }).click();
  const rows = page.locator('.exercise-picker__row');
  if ((await rows.count()) > 0) {
    const pickedName = await page.locator('.exercise-picker__row-name').first().textContent();
    await rows.first().click();
    await expect(page.locator('.composer-exercises')).toContainText(pickedName!);
    await shot(page, 'composer-with-exercise');
  } else {
    await page.keyboard.press('Escape');
  }

  // Apply. Signed in, POST /api/workout-templates and /api/events are both
  // stubbed and the builder closes; offline saveTemplate returns null →
  // failure toast, stays open.
  await page.locator('.exercise-editor__save').click();
  if (!supabaseRef()) {
    await expect(page.locator('.composer-view'), 'builder stays open when the save fails').toBeVisible();
    await expect(page.getByText('Failed to save').first(), 'offline save surfaces the failure toast').toBeVisible();
  } else {
    await expect(page.locator('.composer-view'), 'builder closes after a successful apply').toHaveCount(0);
  }
  await shot(page, 'builder-applied');
});
