import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// "Duplicate to…" (workout modal) and "Copy last week" (an empty week), both
// through POST /api/events with triggered_by 'user' and a copy-<uuid> id —
// never the /api/workout-draft door, which retro-logs past-dated creates.
//
// The mock clock is Mon 2026-09-07. workout_events is stubbed per test so
// the viewed week (Sep 7–13) is empty and the week before it holds two
// one-offs and one occurrence of a weekly series anchored the week before
// that (so the series' own base row is outside both weeks).

const ROW = {
  subtitle: null, description: '', warmup: [], exercises: [], cooldown: [], difficulty: 3,
  location: null, cover_image_url: null, tags: [], equipment: [], sport: null, template_id: null,
  is_recurring: false, recurrence_rule: null, recurring_frequency: null, recurring_days: null,
  recurring_end_date: null, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

const ROWS = [
  {
    ...ROW, id: 'prev-mon-upper', type: 'weights', title: 'Upper Body', date: '2026-08-31',
    start_time: '6:00 AM', end_time: '7:00 AM', estimated_duration: 60, tags: ['push'], template_id: 'wt-upper',
    exercises: [{ id: 'ex1', definitionId: 'bench-press', name: 'Bench Press', category: 'strength', sets: 4, reps: '6' }],
  },
  {
    ...ROW, id: 'prev-thu-run', type: 'cardio', sport: 'running', title: 'Easy Run', date: '2026-09-03',
    start_time: '7:00 AM', end_time: '7:40 AM', estimated_duration: 40,
  },
  {
    ...ROW, id: 'prev-series', type: 'climbing', title: 'ARC Series', date: '2026-08-24',
    start_time: '5:00 PM', end_time: '6:00 PM', estimated_duration: 60,
    is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260906',
  },
];

const COPY_ID = /^copy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function stubSchedule(page: Page) {
  await page.route(/rest\/v1\/workout_events/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS) }));
}

/** Every non-GET /api/events body, plus every other write path that must stay silent. */
function recordWrites(page: Page) {
  const creates: Array<Record<string, unknown>> = [];
  const other: string[] = [];
  page.on('request', (req: Request) => {
    const { pathname } = new URL(req.url());
    if (req.method() === 'GET' || !pathname.startsWith('/api/')) return;
    if (pathname === '/api/events' && req.method() === 'POST') creates.push(req.postDataJSON());
    else if (['/api/workout-draft', '/api/event-instances', '/api/completions', '/api/workout-sessions'].includes(pathname)) {
      other.push(`${req.method()} ${pathname}`);
    }
  });
  return { creates, other };
}

test('Duplicate to… makes a one-off copy on the chosen date and warns about a past one', async ({ page }) => {
  await stubSchedule(page);
  const { creates, other } = recordWrites(page);
  await gotoCalendar(page);

  await page.locator('.event-chip__main', { hasText: 'Upper Body' }).click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();
  // The existing reschedule chips are untouched: the duplicate chip is its own control.
  await expect(page.locator('.modal-meta-item--edit')).toHaveCount(2);

  await page.getByTestId('duplicate-to').click();
  const dateInput = page.getByTestId('duplicate-date');
  await expect(dateInput, 'defaults to a week later').toHaveValue('2026-09-07');
  await shot(page, 'duplicate-date-picking');
  await dateInput.fill('2026-09-15');
  await dateInput.press('Enter');

  await expect(page.locator('.toast', { hasText: 'Copied to Tue, Sep 15 —' })).toBeVisible();
  expect(creates.length, 'one POST /api/events').toBe(1);
  const body = creates[0];
  expect(body.id).toMatch(COPY_ID);
  expect(body).toMatchObject({
    triggered_by: 'user', type: 'weights', title: 'Upper Body', date: '2026-09-15',
    start_time: '6:00 AM', end_time: '7:00 AM', estimated_duration: 60, tags: ['push'], template_id: 'wt-upper',
    is_recurring: false, recurrence_rule: null, recurring_frequency: null, recurring_days: null, recurring_end_date: null,
  });
  expect((body.exercises as unknown[]).length).toBe(1);
  expect(body).not.toHaveProperty('is_completed');
  expect(body).not.toHaveProperty('completed_at');
  expect(body).not.toHaveProperty('source');
  // The modal stays on the original.
  await expect(page.locator('#modal-title')).toHaveText('Upper Body');
  await expect(page.locator('.modal-backdrop')).toBeVisible();

  // A past date (the clock is Sep 7) waits for an explicit Copy anyway.
  await page.getByTestId('duplicate-to').click();
  await page.getByTestId('duplicate-date').fill('2026-09-01');
  await page.getByTestId('duplicate-date').press('Enter');
  await expect(page.getByTestId('duplicate-past-confirm')).toBeVisible();
  await expect(page.getByTestId('duplicate-past-confirm')).toContainText('Tue, Sep 1 is in the past');
  expect(creates.length, 'nothing created before the confirm').toBe(1);
  await shot(page, 'duplicate-past-confirm');
  await page.getByTestId('duplicate-past-anyway').click();
  await expect(page.locator('.toast', { hasText: 'Copied to Tue, Sep 1 —' })).toBeVisible();
  await expect(page.getByTestId('duplicate-past-confirm')).toHaveCount(0);
  expect(creates.length).toBe(2);
  expect(creates[1]).toMatchObject({ date: '2026-09-01', triggered_by: 'user', is_recurring: false });
  expect(creates[1].id).toMatch(COPY_ID);
  expect(creates[1].id).not.toBe(creates[0].id);

  expect(other, 'no other write path is touched').toEqual([]);
});

test('a series occurrence duplicates as a one-off of that occurrence', async ({ page }) => {
  await stubSchedule(page);
  const { creates } = recordWrites(page);
  await gotoCalendar(page);

  await page.locator('.event-chip__main', { hasText: 'ARC Series' }).click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();
  await page.getByTestId('duplicate-to').click();
  await page.getByTestId('duplicate-date').fill('2026-09-16');
  await page.getByTestId('duplicate-date').press('Enter');
  await expect(page.locator('.toast', { hasText: 'Copied to Wed, Sep 16' })).toBeVisible();

  expect(creates.length).toBe(1);
  expect(creates[0].id).toMatch(COPY_ID);
  expect(creates[0]).toMatchObject({
    title: 'ARC Series', date: '2026-09-16', start_time: '5:00 PM', end_time: '6:00 PM',
    is_recurring: false, recurrence_rule: null, recurring_frequency: null, recurring_days: null, recurring_end_date: null,
    triggered_by: 'user',
  });
});

test('Copy last week copies the one-offs forward by seven days and skips the series', async ({ page }) => {
  await stubSchedule(page);
  const { creates, other } = recordWrites(page);
  await gotoCalendar(page);

  // The month view has no "viewed week" — no banner there.
  await expect(page.getByTestId('copy-week')).toHaveCount(0);

  await page.locator('.view-toggle__btn', { hasText: 'Week' }).click();
  await expect(page.locator('.nav-period')).toHaveText('Sep 7 – 13, 2026');
  const banner = page.getByTestId('copy-week');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('1 repeating one stays on its series');
  await expect(page.getByTestId('copy-week-btn')).toHaveText('Copy last week (2)');
  await shot(page, 'copy-week-banner');

  await page.getByTestId('copy-week-btn').click();
  await expect(page.locator('.toast', { hasText: 'Copied 2 workouts; skipped 1 repeating one' })).toBeVisible();

  expect(creates.map(c => [c.title, c.date])).toEqual([
    ['Upper Body', '2026-09-07'],
    ['Easy Run', '2026-09-10'],
  ]);
  for (const body of creates) {
    expect(body.id).toMatch(COPY_ID);
    expect(body).toMatchObject({
      triggered_by: 'user', is_recurring: false, recurrence_rule: null,
      recurring_frequency: null, recurring_days: null, recurring_end_date: null,
    });
    expect(body).not.toHaveProperty('is_completed');
  }
  expect(new Set(creates.map(c => c.id)).size, 'fresh ids').toBe(2);
  expect(creates[0]).toMatchObject({ start_time: '6:00 AM', end_time: '7:00 AM', template_id: 'wt-upper' });
  expect(creates[1]).toMatchObject({ sport: 'running', estimated_duration: 40 });
  expect(other, 'no other write path is touched').toEqual([]);

  // A week whose previous week is empty says so instead of offering a button.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.nav-period')).toHaveText('Sep 14 – 20, 2026');
  await expect(page.getByTestId('copy-week-empty')).toHaveText('Nothing to copy from last week.');
  await expect(page.getByTestId('copy-week-btn')).toHaveCount(0);
  await shot(page, 'copy-week-nothing');

  // A week with events on it has no banner at all.
  await page.getByRole('button', { name: 'Previous' }).click();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.locator('.nav-period')).toHaveText('Aug 31 – Sep 6, 2026');
  await expect(page.getByTestId('copy-week')).toHaveCount(0);
});

test('a failed insert stops the run and reports what landed', async ({ page, consoleErrors }) => {
  await stubSchedule(page);
  let posts = 0;
  // Outranks the context stub: the second insert fails.
  await page.route('**/api/events', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts += 1;
    return posts === 2
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'Failed to create event' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'copy-x' }) });
  });
  await gotoCalendar(page);
  await page.locator('.view-toggle__btn', { hasText: 'Week' }).click();
  await page.getByTestId('copy-week-btn').click();
  await expect(page.locator('.toast', { hasText: 'Copied 1 of 2 (Upper Body). Not copied: Easy Run' })).toBeVisible();
  expect(posts, 'sequential: nothing after the failure is attempted').toBe(2);

  // The browser logs every 5xx as a console error; this one is the test's
  // own doing (the coach-notebook spec's precedent). Remove exactly it so
  // the fixture's no-console-errors assertion still guards everything else.
  await expect.poll(() => consoleErrors.filter(e => e.includes('status of 500')).length).toBe(1);
  consoleErrors.splice(consoleErrors.findIndex(e => e.includes('status of 500')), 1);
});
