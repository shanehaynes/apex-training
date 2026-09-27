import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// Coach annotations on the calendar: a seeded day note renders as a chip in
// its day cell, a seeded event note as a marker on its event chip, and the
// chip's dismiss removes it without opening the day it sits on. The week
// view carries a marker per noted day header and event block. On a phone the
// day view is the whole calendar (AppShell forces it at ≤768px), and it is
// where an event note can be dismissed at all — the month grid's marker only
// points there. The default mock intercept answers /api/coach-annotations
// with `{ ok: true }` (no notes); this spec's page.route outranks it.
//
// FAKE_NOW is 2026-09-07 (a Monday), so the month grid runs 2026-08-31 –
// 2026-10-04 and the day view opens on the 7th, with the 8th one tap away in
// its week strip. ext-2026-09-01-stretch and ext-2026-09-08-stretch are
// non-recurring seed events, so their occurrence ids are their bare ids.

const DAY_NOTE = {
  id: '11111111-2222-4333-8444-555555555555',
  target_kind: 'day',
  target_id: '2026-09-08',
  body: 'Deload this week — load ratio 1.4 is well above the 1.3 ceiling.',
  severity: 'caution',
  created_by: 'coach',
  created_at: '2026-09-07T07:00:00Z',
  dismissed_at: null,
};

const EVENT_NOTE = {
  id: '22222222-2222-4333-8444-555555555555',
  target_kind: 'event',
  target_id: 'ext-2026-09-01-stretch',
  body: 'Skip the spine work if the back is still tight.',
  severity: 'alert',
  created_by: 'coach',
  created_at: '2026-09-07T07:00:00Z',
  dismissed_at: null,
};

/** An event note on the 8th: the day the phone test taps to in the week strip. */
const PHONE_EVENT_NOTE = {
  ...EVENT_NOTE,
  id: '33333333-2222-4333-8444-555555555555',
  target_id: 'ext-2026-09-08-stretch',
  body: 'Ease off the hamstring holds — 20 seconds, not 40.',
};

function seedAnnotations(page: Page, notes: object[] = [DAY_NOTE, EVENT_NOTE]) {
  const requests: Request[] = [];
  const route = page.route('**/api/coach-annotations**', route => {
    const req = route.request();
    requests.push(req);
    if (req.method() === 'GET') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ annotations: notes }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return { route, requests };
}

const deletes = (requests: Request[]) => requests.filter(r => r.method() === 'DELETE');

test('a seeded note renders on its day and its event, and dismiss removes it without opening the day', async ({ page }) => {
  const { route, requests } = seedAnnotations(page);
  await route;
  await gotoCalendar(page);

  // The read asked for exactly the visible grid.
  const load = requests.find(r => r.method() === 'GET');
  expect(load, 'the calendar fetched its notes').toBeTruthy();
  const url = new URL(load!.url());
  expect(url.searchParams.get('from')).toBe('2026-08-31');
  expect(url.searchParams.get('to')).toBe('2026-10-04');

  // Day chip: the first ~40 characters, the whole note on hover, severity as data.
  const chip = page.getByTestId('annotation-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText('Deload this week — load ratio 1.4 is…');
  await expect(chip).toHaveAttribute('title', DAY_NOTE.body);
  await expect(chip).toHaveAttribute('data-severity', 'caution');
  // It sits in the cell for the 8th.
  const cell = page.locator('.day-cell', { has: page.getByRole('button', { name: 'View September 8' }) });
  await expect(cell.getByTestId('annotation-chip')).toBeVisible();

  // Event marker: on the seeded event's chip, coloured by the note's severity.
  const marker = page.getByTestId('event-annotation-marker');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute('data-severity', 'alert');
  await expect(marker).toHaveAttribute('title', EVENT_NOTE.body);
  await expect(page.locator('.event-chip', { has: marker }).locator('.event-chip__label'))
    .toContainText('Nightly Stretch — Lower');
  await shot(page, 'coach-annotations-month');

  // Dismiss: optimistic removal, one DELETE with the id, and the day modal
  // stays closed — the chip's click stopped short of the cell's.
  await chip.getByRole('button', { name: 'Dismiss coach note' }).click();
  await expect(page.getByTestId('annotation-chip')).toHaveCount(0);
  await expect.poll(() => requests.filter(r => r.method() === 'DELETE').length).toBe(1);
  const dismissed = requests.find(r => r.method() === 'DELETE')!;
  expect(dismissed.postDataJSON()).toEqual({ id: DAY_NOTE.id });
  await expect(page.locator('.day-modal__header')).toHaveCount(0);

  // The event marker is untouched by a day dismiss.
  await expect(page.getByTestId('event-annotation-marker')).toHaveCount(1);
});

test('the week view marks a noted day header and a noted event block', async ({ page }) => {
  const { route } = seedAnnotations(page);
  await route;
  await gotoCalendar(page);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.week-view')).toBeVisible();

  // Sep 7–13: the day note on the 8th marks Tuesday's header; the event note
  // on the 1st is in the week before, so no block carries a marker yet.
  const dayMarker = page.getByTestId('day-annotation-marker');
  await expect(dayMarker).toHaveCount(1);
  await expect(dayMarker).toHaveAttribute('data-severity', 'caution');
  await expect(dayMarker).toHaveAttribute('title', DAY_NOTE.body);
  await expect(page.locator('.week-view__day-header', { has: dayMarker })).toContainText('Tue');
  await expect(page.getByTestId('event-annotation-marker')).toHaveCount(0);

  // Aug 31 – Sep 6: the seeded event's block carries its marker, and its
  // click target still opens the workout.
  await page.getByRole('button', { name: 'Previous' }).click();
  const eventMarker = page.getByTestId('event-annotation-marker');
  await expect(eventMarker).toHaveCount(1);
  await expect(eventMarker).toHaveAttribute('data-severity', 'alert');
  await expect(eventMarker).toHaveAttribute('title', EVENT_NOTE.body);
  const block = page.locator('.week-event', { has: eventMarker });
  await expect(block.locator('.week-event__title')).toContainText('Nightly Stretch — Lower');
  await expect(page.getByTestId('day-annotation-marker')).toHaveCount(0);
  await shot(page, 'coach-annotations-week');
  await block.locator('.week-event__main').click();
  await expect(page.locator('.modal')).toBeVisible();
});

test('the default mock answer (no notes) renders a calendar with no chips or markers', async ({ page }) => {
  await gotoCalendar(page);
  await expect(page.getByTestId('annotation-chip')).toHaveCount(0);
  await expect(page.getByTestId('event-annotation-marker')).toHaveCount(0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the day view shows day and event notes whole, and dismisses each without opening anything', async ({ page }) => {
    const { route, requests } = seedAnnotations(page, [DAY_NOTE, EVENT_NOTE, PHONE_EVENT_NOTE]);
    await route;
    await page.goto('/');
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });

    // The 7th has no notes: nothing renders, and nothing is hidden either.
    await expect(page.locator('.day-event-card').first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('annotation-chip')).toHaveCount(0);

    // One tap along the week strip to the 8th.
    await page.getByRole('button', { name: 'Tuesday, September 8' }).click();

    // The day note: whole body (not the month pill's ~40 characters), above the cards.
    const dayStrip = page.getByTestId('day-annotations');
    const dayChip = dayStrip.getByTestId('annotation-chip');
    await expect(dayChip).toHaveCount(1);
    await expect(dayChip).toHaveText(DAY_NOTE.body);
    await expect(dayChip).toHaveAttribute('data-severity', 'caution');
    const stripBox = await dayStrip.boundingBox();
    const cardBox = await page.locator('.day-event-card').first().boundingBox();
    expect(stripBox!.y + stripBox!.height, 'day notes sit above the cards').toBeLessThanOrEqual(cardBox!.y);

    // The event note: in its card, under the title row, whole.
    const card = page.locator('.day-event-card', { hasText: 'Nightly Stretch — Lower' });
    const eventChip = card.getByTestId('event-annotations').getByTestId('annotation-chip');
    await expect(eventChip).toHaveCount(1);
    await expect(eventChip).toHaveText(PHONE_EVENT_NOTE.body);
    await expect(eventChip).toHaveAttribute('data-severity', 'alert');
    const titleBox = await card.locator('.day-event-card__title').boundingBox();
    const chipBox = await eventChip.boundingBox();
    expect(chipBox!.y, 'event note sits below the title row').toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    await shot(page, 'coach-annotations-day');

    // Dismissing the event note: the only place it can be dismissed. One
    // DELETE with its id, the workout modal stays closed, the day note stays.
    await eventChip.getByRole('button', { name: 'Dismiss coach note' }).click();
    await expect(card.getByTestId('annotation-chip')).toHaveCount(0);
    await expect.poll(() => deletes(requests).length).toBe(1);
    expect(deletes(requests)[0].postDataJSON()).toEqual({ id: PHONE_EVENT_NOTE.id });
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(dayChip).toHaveCount(1);
    await expect(card).toBeVisible();

    // Dismissing the day note: a second DELETE, the strip goes, the card stays.
    await dayChip.getByRole('button', { name: 'Dismiss coach note' }).click();
    await expect(page.getByTestId('annotation-chip')).toHaveCount(0);
    await expect(page.getByTestId('day-annotations')).toHaveCount(0);
    await expect.poll(() => deletes(requests).length).toBe(2);
    expect(deletes(requests)[1].postDataJSON()).toEqual({ id: DAY_NOTE.id });
    await expect(card).toBeVisible();
  });

  // A rest day with a note (the strip above the empty state) has no e2e: the
  // seed puts a nightly stretch on every day the week strip can reach. It is
  // proved at the markup level in src/components/calendar/__tests__/
  // annotationsInViews.test.tsx.
});
