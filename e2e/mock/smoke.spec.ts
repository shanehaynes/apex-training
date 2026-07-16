import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

test('calendar renders and the event modal opens', async ({ page }) => {
  await gotoCalendar(page);

  const schedule = await apexState<{ eventCount: number; isEventsLoading: boolean }>(page, 'schedule');
  expect(schedule.eventCount).toBeGreaterThan(0);
  expect(schedule.isEventsLoading).toBe(false);
  await shot(page, 'calendar');

  await page.locator('.event-chip__main').first().click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();
  await shot(page, 'event-modal');

  const calendar = await apexState<{ selectedEventId: string | null }>(page, 'calendar');
  expect(calendar.selectedEventId).toBeTruthy();
});
