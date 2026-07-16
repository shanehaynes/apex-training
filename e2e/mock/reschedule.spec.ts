import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

test('date and time chips swap to inputs; Escape cancels without closing', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();

  const chips = page.locator('.modal-meta-item--edit');
  await expect(chips, 'date + time edit chips').toHaveCount(2);

  // The date chip swaps to a native date input on click.
  await chips.first().click();
  const dateInput = page.locator('.modal-meta-input[type="date"]');
  await expect(dateInput).toBeVisible();
  await shot(page, 'reschedule-date-editing');

  // Escape cancels without committing and restores the text display.
  await dateInput.press('Escape');
  await expect(page.locator('.modal-meta-item--edit').first(), 'Escape restores the date display').toBeVisible();
  await expect(page.locator('.modal-backdrop'), 'Escape in the input must not close the modal').toBeVisible();

  // The time chip swaps to start/end time inputs on click.
  await page.locator('.modal-meta-item--edit').nth(1).click();
  await expect(page.locator('.modal-meta-input[type="time"]')).toHaveCount(2);
  await shot(page, 'reschedule-time-editing');
});
