import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// Coach annotations on the calendar: a seeded day note renders as a chip in
// its day cell, a seeded event note as a marker on its event chip, and the
// chip's dismiss removes it without opening the day it sits on. The default
// mock intercept answers /api/coach-annotations with `{ ok: true }` (no
// notes); this spec's page.route outranks it and seeds two.
//
// FAKE_NOW is 2026-09-07, so the month grid runs 2026-08-31 – 2026-10-04.
// ext-2026-09-01-stretch is a non-recurring seed event on the 1st, so its
// occurrence id is its bare id.

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

function seedAnnotations(page: Page) {
  const requests: Request[] = [];
  const route = page.route('**/api/coach-annotations**', route => {
    const req = route.request();
    requests.push(req);
    if (req.method() === 'GET') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ annotations: [DAY_NOTE, EVENT_NOTE] }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return { route, requests };
}

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

test('the default mock answer (no notes) renders a calendar with no chips or markers', async ({ page }) => {
  await gotoCalendar(page);
  await expect(page.getByTestId('annotation-chip')).toHaveCount(0);
  await expect(page.getByTestId('event-annotation-marker')).toHaveCount(0);
});
