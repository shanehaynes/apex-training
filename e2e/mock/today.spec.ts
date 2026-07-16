import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

test('Today button state tracks the visible period', async ({ page }) => {
  await gotoCalendar(page);
  const todayBtn = page.locator('.btn-today');
  const period = page.locator('.nav-period');

  await expect(todayBtn, 'Today disabled on the current period').toBeDisabled();
  await shot(page, 'today-disabled');

  await page.locator('.nav-arrow[aria-label="Next"]').click();
  await expect(todayBtn, 'Today enabled after paging forward').toBeEnabled();
  await shot(page, 'today-enabled');

  const away = await period.textContent();
  await todayBtn.click();
  await expect(period, 'clicking Today returns to the current period').not.toHaveText(away!);
  await expect(todayBtn, 'Today disabled again after clicking it').toBeDisabled();
  await shot(page, 'today-after-click');
});
