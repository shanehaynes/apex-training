import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

// The repeat picker's daily rules and count-based ends. The picker only
// authors the rule; the recurrence engine already expands DAILY and COUNT,
// which is what the calendar assertions prove — nothing in the calendar or
// the week view changed for this.

interface StateEvent {
  id: string;
  title: string;
  date: string;
  isRecurring: boolean;
  recurrenceRule?: string;
}

const stateEvents = (page: Page) =>
  apexState<{ events: StateEvent[] }>(page, 'schedule').then(s => s.events);

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const plusDays = (date: string, n: number) =>
  new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + n)).toISOString().slice(0, 10);

async function openNewWorkout(page: Page, title: string) {
  await gotoCalendar(page);
  await page.getByTestId('nav-add-workout').click();
  await page.locator('.builder-search__create').click();
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill(title);
  await page.locator('.builder-repeat__switch').click();
}

test('a daily series ending after N times expands onto the calendar and the week view', async ({ page }) => {
  await openNewWorkout(page, 'Mobility Daily');
  const card = page.locator('.builder-repeat');

  // Weekly is the default; switching to Daily hides the day chips and
  // relabels the interval.
  await expect(card.getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: 'Daily' }).click();
  await expect(card.locator('.builder-repeat__days')).toHaveCount(0);
  await card.getByLabel('Repeat interval').fill('2');
  await expect(card.locator('.builder-repeat__interval')).toContainText('days');

  // "After N times" is an end of its own: typing a count clears a date and
  // vice versa, and Never clears both.
  await card.getByLabel('Repeat until').fill('2027-01-31');
  await card.getByLabel('Repeat count').fill('6');
  await expect(card.getByLabel('Repeat until')).toHaveValue('');
  await card.getByLabel('Repeat until').fill('2027-01-31');
  await expect(card.getByLabel('Repeat count')).toHaveValue('');
  await card.getByRole('button', { name: 'Never' }).click();
  await expect(card.getByLabel('Repeat until')).toHaveValue('');
  await card.getByLabel('Repeat count').fill('6');
  await shot(page, 'builder-repeat-daily-count');
  // The week grid draws timed events only.
  await page.locator('.library-field', { hasText: 'Start time' }).locator('input[type="time"]').fill('07:00');

  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  // Six occurrences, the anchor included, two days apart — and nothing
  // after the sixth, because COUNT ends the series.
  const series = (await stateEvents(page)).filter(e => e.title === 'Mobility Daily');
  expect(series.length, 'exactly COUNT occurrences').toBe(6);
  expect(series[0].recurrenceRule).toBe('FREQ=DAILY;INTERVAL=2;COUNT=6');
  expect(series.every(e => e.isRecurring)).toBe(true);
  const dates = series.map(e => e.date).sort();
  expect(dates).toEqual([0, 2, 4, 6, 8, 10].map(n => plusDays(dates[0], n)));

  // The month and the week both render the series untouched.
  await expect(page.locator('.event-chip__main', { hasText: 'Mobility Daily' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.week-view')).toBeVisible();
  await expect(page.locator('.week-event__title', { hasText: 'Mobility Daily' }).first()).toBeVisible();
  await shot(page, 'week-repeat-daily-count');
});

test('a weekly series can end after N times too', async ({ page }) => {
  await openNewWorkout(page, 'Counted Weekly');
  const card = page.locator('.builder-repeat');
  await card.getByLabel('Repeat on MO').click();
  await card.getByLabel('Repeat on TH').click();
  await card.getByLabel('Repeat count').fill('4');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  const series = (await stateEvents(page)).filter(e => e.title === 'Counted Weekly');
  expect(series.length).toBe(4);
  expect(series[0].recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4');
  expect(
    series.map(e => weekdayOf(e.date)).filter(d => d !== 1 && d !== 4),
    'every occurrence lands on a Monday or a Thursday',
  ).toEqual([]);
});

test('a daily series reopens in the picker as daily, not as a custom pattern', async ({ page }) => {
  await openNewWorkout(page, 'Reopen Daily');
  const card = page.locator('.builder-repeat');
  await card.getByRole('button', { name: 'Daily' }).click();
  await card.getByLabel('Repeat count').fill('3');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  await page.locator('.event-chip__main', { hasText: 'Reopen Daily' }).first().click();
  await page.locator('.modal-edit-workout').click();
  await expect(card.locator('.builder-repeat__custom')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Daily' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByLabel('Repeat count')).toHaveValue('3');
  await expect(card.locator('.builder-repeat__switch'), 'a series cannot be switched off here').toHaveCount(0);
});
