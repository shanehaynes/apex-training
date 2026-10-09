import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
import { stubLibrary } from '../lib/library';

test('add an exercise via the picker and save (stubbed PATCH)', async ({ page }) => {
  await gotoCalendar(page);
  const schedule = await apexState<{ definitionIds: string[] }>(page, 'schedule');
  test.skip(schedule.definitionIds.length === 0,
    'picker is empty (offline seed mode — needs Supabase-backed definitions)');

  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-edit-exercises').click();
  await expect(page.locator('.editor-card').first()).toBeVisible();
  const cardsBefore = await page.locator('.editor-card').count();
  await shot(page, 'edit-exercises-editor');

  // Add via the picker into the first (Warm-Up) section.
  await page.locator('.exercise-editor__add').first().click();
  await expect(page.locator('.exercise-picker__row').first()).toBeVisible();
  await page.locator('.exercise-picker__input').fill('plank');
  await shot(page, 'edit-exercises-picker');
  const addedName = await page.locator('.exercise-picker__row-name').first().textContent();
  await page.locator('.exercise-picker__row').first().click();

  await expect(page.locator('.editor-card')).toHaveCount(cardsBefore + 1);

  // Edit a prescription field on the new card, then save (PATCH is stubbed;
  // the optimistic update must surface the change in the read view).
  const input = page.locator('.editor-card').last().locator('.editor-field input').first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill('4');
  }
  await shot(page, 'edit-exercises-added');

  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.exercise-card').first()).toBeVisible();
  await expect(page.locator('.modal-body')).toContainText(addedName!);
  await shot(page, 'edit-exercises-saved');
});


test('a typo in the picker offers the library name before Create', async ({ page }) => {
  await stubLibrary(page);
  await gotoCalendar(page);

  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-edit-exercises').click();
  await page.locator('.exercise-editor__add').first().click();
  await page.locator('.library-filter', { hasText: 'All' }).click();
  await page.locator('.exercise-picker__input').fill('Pnacake Fold');

  const suggestions = page.locator('.exercise-picker__row', { hasText: 'did you mean?' }).locator('.exercise-picker__row-name');
  await expect(suggestions).toHaveText(['Pancake Fold', 'Pancake Hold']);
  await expect(page.locator('.exercise-picker__create-row')).toContainText('Create "Pnacake Fold" as a new exercise anyway');
  await shot(page, 'picker-did-you-mean');

  // A new name nowhere near the library gets a plain Create, no suggestions.
  await page.locator('.exercise-picker__input').fill('Copenhagen Plank');
  await expect(suggestions).toHaveCount(0);
  await expect(page.locator('.exercise-picker__create-row')).not.toContainText('anyway');
});
