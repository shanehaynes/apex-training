import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

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

// The shared intercept stubs the library empty; this spec brings its own, so
// it runs in CI's offline mock job rather than joining the expected skips.
const LIBRARY = [
  ['pancake-fold', 'Pancake Fold', 'stretch'],
  ['pancake-hold', 'Pancake Hold', 'stretch'],
  ['bench-press', 'Bench Press', 'strength'],
].map(([id, name, category]) => ({
  id, canonical_name: name, aliases: [], category, muscle_groups: [], equipment: [], is_unilateral: false,
  image_url: null, technique_notes: null, default_sets: null, default_reps: null, default_duration: null,
  default_weight: null, default_rest: null, archived_at: null,
}));

test('a typo in the picker offers the library name before Create', async ({ page }) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  await page.route('**/rest/v1/exercise_definitions**', route =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(LIBRARY) }));
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
