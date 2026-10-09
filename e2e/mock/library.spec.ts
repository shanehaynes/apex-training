import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
import { stubLibrary } from '../lib/library';

test('library list, detail, editor, and deep link', async ({ page }) => {
  await gotoCalendar(page);
  const schedule = await apexState<{ definitionIds: string[] }>(page, 'schedule');
  test.skip(schedule.definitionIds.length === 0,
    'library is empty (offline seed mode — needs Supabase-backed definitions)');

  await page.locator('.btn-library').click();
  await expect(page.locator('.library-row').first()).toBeVisible();
  await shot(page, 'library-list');

  await page.locator('.library-row').first().click();
  await expect(page.locator('.library-detail')).toBeVisible();
  await shot(page, 'library-detail');

  await page.locator('.library-edit-btn').click();
  await expect(page.locator('.library-editor')).toBeVisible();
  await shot(page, 'library-editor');
  await page.locator('.library-editor__cancel').click();

  // Deep link: an exercise name in the workout modal opens its detail page.
  await page.locator('.library-close').click();
  await page.locator('.event-chip__main').first().click();
  await page.locator('.exercise-card__name--link').first().click();
  await expect(page.locator('.library-detail')).toBeVisible();
  await shot(page, 'library-deeplink');
});

test('the library search offers "did you mean" and creates what is missing, as the picker does', async ({ page }) => {
  await stubLibrary(page);
  await gotoCalendar(page);
  await page.locator('.btn-library', { hasText: 'Library' }).click();
  await expect(page.locator('.library-row').first()).toBeVisible();

  const search = page.locator('.library-search__input');
  await search.fill('Pnacake Fold');
  const suggestions = page.locator('.library-row', { hasText: 'did you mean?' }).locator('.library-row__name');
  await expect(suggestions).toHaveText(['Pancake Fold', 'Pancake Hold']);
  await expect(page.locator('.exercise-picker__create-row')).toContainText('Create "Pnacake Fold" as a new exercise anyway');
  await shot(page, 'library-did-you-mean');

  // An exact name is the existing row, never a create.
  await search.fill('pancake fold');
  await expect(page.locator('.exercise-picker__create-row')).toHaveCount(0);

  // A new name creates in place and opens the new exercise.
  await search.fill('Copenhagen Plank');
  await expect(suggestions).toHaveCount(0);
  await page.locator('.exercise-picker__create-row').click();
  await page.locator('.exercise-picker__create-form select').selectOption('strength');
  await page.locator('.exercise-picker__create-form .library-editor__save').click();
  await expect(page.locator('.library-detail')).toBeVisible();
  await expect(page.locator('.library-header__title')).toHaveText('Copenhagen Plank');
  await expect(page.locator('.library-detail__meta')).toContainText('strength');
});
