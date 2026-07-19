import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

test('modal title swaps to an input on click; Escape cancels without closing', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();

  const title = page.locator('.modal-title');
  const original = await title.textContent();

  // The title swaps to a text input on click, prefilled with the current title.
  await title.click();
  const input = page.locator('.modal-title--input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(original ?? '');
  await shot(page, 'rename-title-editing');

  // Escape cancels without committing and restores the heading.
  await input.fill('Discarded edit');
  await input.press('Escape');
  await expect(page.locator('h2.modal-title'), 'Escape restores the title display').toHaveText(original ?? '');
  await expect(page.locator('.modal-backdrop'), 'Escape in the input must not close the modal').toBeVisible();
});
