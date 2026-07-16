import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

// The fake clock (src/lib/clock.ts) freezes date-semantic logic so calendar
// renders are reproducible across real days. The frozen date must fall inside
// the seed schedule's range (recurring events expand forward from ~June 2026).
test.use({ fakeNow: '2026-09-07T08:00:00' });

test('fake clock anchors the calendar to the injected date', async ({ page }) => {
  await gotoCalendar(page);

  const calendar = await apexState<{ currentDate: string }>(page, 'calendar');
  expect(calendar.currentDate.startsWith('2026-09')).toBe(true);
  await expect(page.locator('.nav-period')).toHaveText('September 2026');
  await expect(page.locator('.btn-today'), 'fake today counts as the current period').toBeDisabled();
  await shot(page, 'clock-frozen-september');

  // Paging away and back lands on the fake date, not the real one.
  await page.locator('.nav-arrow[aria-label="Next"]').click();
  await expect(page.locator('.nav-period')).toHaveText('October 2026');
  await page.locator('.btn-today').click();
  await expect(page.locator('.nav-period')).toHaveText('September 2026');
});
