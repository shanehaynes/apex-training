import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

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
