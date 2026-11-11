import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
import { stubLibrary, LIBRARY } from '../lib/library';

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
  await page.locator('.exercise-picker__input').fill('plank');
  await expect(page.locator('.exercise-picker__row').first()).toBeVisible();
  await shot(page, 'edit-exercises-picker');
  const addedName = await page.locator('.exercise-picker__row-name').first().textContent();
  await page.locator('.exercise-picker__row').first().click();
  await page.locator('.exercise-picker__done').click();

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

test('several exercises can be picked in a row and added with one Done', async ({ page }) => {
  await stubLibrary(page);
  await gotoCalendar(page);

  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-edit-exercises').click();
  await expect(page.locator('.editor-card').first()).toBeVisible();
  const cardsBefore = await page.locator('.editor-card').count();

  await page.locator('.exercise-editor__add').first().click();
  const picker = page.locator('.exercise-picker');
  await picker.locator('.library-filter', { hasText: 'All' }).click();
  const rows = picker.locator('.exercise-picker__row');
  const input = picker.locator('.exercise-picker__input');

  // Nothing is listed until something is typed.
  await expect(rows).toHaveCount(0);
  await expect(picker.locator('.exercise-picker__hint')).toBeVisible();
  await input.fill('pancake');
  await expect(rows).toHaveCount(2);

  // A pick queues the movement, clears the search and keeps the picker open.
  await rows.filter({ hasText: 'Pancake Fold' }).click();
  await expect(picker).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(rows).toHaveCount(0);
  const queued = picker.locator('.exercise-picker__queue-row .exercise-picker__row-name');
  await expect(queued).toHaveText(['Pancake Fold']);

  await input.fill('bench');
  await rows.filter({ hasText: 'Bench Press' }).click();
  await input.fill('hold');
  await rows.filter({ hasText: 'Pancake Hold' }).click();
  await expect(queued).toHaveText(['Pancake Fold', 'Bench Press', 'Pancake Hold']);
  await expect(picker.locator('.exercise-picker__queue-label')).toHaveText('Adding (3)');
  await shot(page, 'picker-adding-several');

  // A queued pick can come off before Done.
  await picker.getByRole('button', { name: 'Remove Pancake Hold' }).click();
  await expect(queued).toHaveText(['Pancake Fold', 'Bench Press']);

  // Escape with a search typed only clears the search; the list survives.
  await input.fill('ben');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await expect(queued).toHaveCount(2);

  await picker.locator('.exercise-picker__done').click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.editor-card')).toHaveCount(cardsBefore + 2);
  await expect(page.locator('.exercise-editor__list').first()).toContainText('Pancake Fold');
  await expect(page.locator('.exercise-editor__list').first()).toContainText('Bench Press');
});

test('closing the picker without Done adds nothing', async ({ page }) => {
  await stubLibrary(page);
  await gotoCalendar(page);

  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-edit-exercises').click();
  await expect(page.locator('.editor-card').first()).toBeVisible();
  const cardsBefore = await page.locator('.editor-card').count();

  await page.locator('.exercise-editor__add').first().click();
  const picker = page.locator('.exercise-picker');
  await picker.locator('.library-filter', { hasText: 'All' }).click();
  await picker.locator('.exercise-picker__input').fill('bench');
  await picker.locator('.exercise-picker__row', { hasText: 'Bench Press' }).click();
  await expect(picker.locator('.exercise-picker__queue-row')).toHaveCount(1);

  await picker.getByRole('button', { name: 'Close picker' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.editor-card')).toHaveCount(cardsBefore);
});

test('the picker search treats single and open as the same word', async ({ page }) => {
  const singleLegRdl = { ...LIBRARY[2], id: 'single-leg-rdl', canonical_name: 'Single-Leg RDL' };
  const openHandHang = { ...LIBRARY[2], id: 'open-hand-hang', canonical_name: 'Open Hand Hang' };
  await stubLibrary(page, [...LIBRARY, singleLegRdl, openHandHang]);
  await gotoCalendar(page);

  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-edit-exercises').click();
  await page.locator('.exercise-editor__add').first().click();
  const picker = page.locator('.exercise-picker');
  await picker.locator('.library-filter', { hasText: 'All' }).click();
  const names = picker.locator('.exercise-picker__row-name');

  await picker.locator('.exercise-picker__input').fill('open');
  await expect(names).toHaveText(['Open Hand Hang', 'Single-Leg RDL']);

  await picker.locator('.exercise-picker__input').fill('single');
  await expect(names).toHaveText(['Open Hand Hang', 'Single-Leg RDL']);
});
