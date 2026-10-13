import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, apexState, shot } from '../lib/fixtures';

// Drag-to-reschedule: a mouse drag moves a chip to another day (month view)
// or another time (week view) through rescheduleEvent, the same seam as the
// modal's date and time chips. The clock is pinned to Mon 2026-09-07
// (playwright.config.ts), so the seed's nightly 9:30 PM stretch sits on
// every day in view. The mock /api/** route answers every PATCH with ok, so
// a request going out is the proof the drop committed.

interface ScheduleState {
  events: Array<{ id: string; date: string; startTime?: string; endTime?: string }>;
}

interface Patch { id: string; fields: Record<string, unknown> }
interface InstanceWrite { eventId: string; date: string; overrides: Record<string, unknown> }

/**
 * What a drop sends: PATCH /api/events for a one-off (by the id in the query
 * string), POST /api/event-instances for a recurring occurrence.
 */
function recordWrites(page: Page): { patches: Patch[]; instances: InstanceWrite[] } {
  const patches: Patch[] = [];
  const instances: InstanceWrite[] = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (req.method() === 'PATCH' && url.pathname === '/api/events') {
      patches.push({ id: url.searchParams.get('id') ?? '', fields: req.postDataJSON().fields });
    } else if (req.method() === 'POST' && url.pathname === '/api/event-instances') {
      const { eventId, date, overrides } = req.postDataJSON();
      instances.push({ eventId, date, overrides });
    }
  });
  return { patches, instances };
}

/** Press, cross the threshold, glide to the target. The caller releases. */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8);
  await page.mouse.move(to.x, to.y, { steps: 10 });
}

async function center(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function eventState(page: Page, id: string) {
  const state = await apexState<ScheduleState>(page, 'schedule');
  return state.events.find(e => e.id === id);
}

test('month view: dragging a chip onto another day moves the occurrence there', async ({ page }) => {
  const { patches, instances } = recordWrites(page);
  await gotoCalendar(page);

  // A one-off: Tue the 8th's stretch onto Wed the 9th (two chips there, so
  // the third stays visible rather than folding into "+1 more").
  const from = '.day-cell[data-drop-date="2026-09-08"] .event-chip[data-event-id="ext-2026-09-08-stretch"]';
  const to = '.day-cell[data-drop-date="2026-09-09"]';
  const start = await center(page, from);
  const end = await center(page, to);
  const before = await page.locator(`${to} .event-chip`).count();

  await dragTo(page, start, end);
  await expect(page.locator(to), 'the hovered cell is marked as the drop target').toHaveClass(/day-cell--drop-target/);
  await expect(page.locator(from), 'the chip lifts while dragged').toHaveClass(/event-chip--dragging/);
  await shot(page, 'calendar-drag-month-hover');
  await page.mouse.up();

  await expect.poll(() => patches.length, 'one PATCH for the move').toBe(1);
  expect(patches[0]).toEqual({ id: 'ext-2026-09-08-stretch', fields: { date: '2026-09-09' } });
  await expect.poll(async () => (await eventState(page, 'ext-2026-09-08-stretch'))?.date).toBe('2026-09-09');
  await expect(page.locator(`${to} .event-chip`), 'the target day gained the chip').toHaveCount(before + 1);
  await expect(page.locator(`${to} .event-chip[data-event-id="ext-2026-09-08-stretch"]`)).toHaveCount(1);
  await expect(page.locator(from)).toHaveCount(0);
  await expect(page.locator(to)).not.toHaveClass(/day-cell--drop-target/);
  // The drop's synthetic click opens nothing — no workout modal, no day modal.
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect(page.locator('.day-modal__list')).toHaveCount(0);
  await shot(page, 'calendar-drag-month-dropped');

  // A recurring occurrence takes the series path: one override keyed at the
  // occurrence's own date, carrying only the new date.
  const routine = page.locator('.day-cell[data-drop-date="2026-09-12"] .event-chip', { hasText: 'Morning Movement Routine' });
  const routineId = await routine.getAttribute('data-event-id');
  expect(routineId, 'the seed routine is a recurring occurrence').toMatch(/__2026-09-12$/);
  const routineBox = await routine.boundingBox();
  if (!routineBox) throw new Error('routine chip not laid out');
  await dragTo(page,
    { x: routineBox.x + routineBox.width / 2, y: routineBox.y + routineBox.height / 2 },
    await center(page, '.day-cell[data-drop-date="2026-09-13"]'));
  await page.mouse.up();

  await expect.poll(() => instances.length, 'one POST for the occurrence').toBe(1);
  expect(instances[0]).toEqual({
    eventId: (routineId ?? '').replace(/__2026-09-12$/, ''),
    date: '2026-09-12',
    overrides: { date: '2026-09-13' },
  });
  expect(patches, 'the series path sends no PATCH').toHaveLength(1);
  await expect(page.locator(`.day-cell[data-drop-date="2026-09-13"] .event-chip[data-event-id="${routineId}"]`)).toHaveCount(1);
  await expect(page.locator(`.day-cell[data-drop-date="2026-09-12"] .event-chip[data-event-id="${routineId}"]`)).toHaveCount(0);
});

test('month view: a same-day drop and an Escape-cancelled drag send nothing; a click still opens the modal', async ({ page }) => {
  const { patches, instances } = recordWrites(page);
  await gotoCalendar(page);

  const chip = '.day-cell[data-drop-date="2026-09-09"] .event-chip[data-event-id="ext-2026-09-09-stretch"]';
  const start = await center(page, chip);

  // Dragged, but released on its own day.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 6, { steps: 4 });
  await expect(page.locator(chip)).toHaveClass(/event-chip--dragging/);
  await page.mouse.up();
  await expect(page.locator('.modal-backdrop'), 'the release did not click the chip open').toHaveCount(0);

  // Dragged to another day, then Escape before release.
  const other = await center(page, '.day-cell[data-drop-date="2026-09-11"]');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(other.x, other.y, { steps: 8 });
  await expect(page.locator('.day-cell[data-drop-date="2026-09-11"]')).toHaveClass(/day-cell--drop-target/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.day-cell[data-drop-date="2026-09-11"]')).not.toHaveClass(/day-cell--drop-target/);
  await expect(page.locator(chip)).not.toHaveClass(/event-chip--dragging/);
  await page.mouse.up();

  expect(patches, 'neither gesture reached the API').toEqual([]);
  expect(instances).toEqual([]);
  expect((await eventState(page, 'ext-2026-09-09-stretch'))?.date).toBe('2026-09-09');
  await expect(page.locator(chip)).toHaveCount(1);

  // A plain click is unchanged: it opens the workout modal.
  await page.locator(`${chip} .event-chip__main`).click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();
});

test('week view: dragging a block up two hours and one column over moves the start, keeps the duration, changes the day', async ({ page }) => {
  const { patches } = recordWrites(page);
  await gotoCalendar(page);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.week-view')).toBeVisible();

  const block = '.week-event[data-event-id="ext-2026-09-09-stretch"]';
  await page.locator(block).scrollIntoViewIfNeeded();
  const start = await center(page, block);
  const fromCol = await page.locator('.week-view__day-col[data-drop-date="2026-09-09"]').boundingBox();
  const toCol = await page.locator('.week-view__day-col[data-drop-date="2026-09-10"]').boundingBox();
  if (!fromCol || !toCol) throw new Error('week columns not laid out');

  // Two hours is 112px at 56px per hour; the grab point stays under the pointer.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y - 8);
  await page.mouse.move(start.x + (toCol.x - fromCol.x), start.y - 112, { steps: 12 });
  await expect(page.locator(block), 'the block lifts while dragged').toHaveClass(/week-event--dragging/);
  await expect(page.locator('.week-view__day-col[data-drop-date="2026-09-10"]')).toHaveClass(/week-view__day-col--drop-target/);
  await expect(page.locator(`${block} .week-event__time`), 'the label previews the snapped landing time').toHaveText('7:30 PM');
  await shot(page, 'calendar-drag-week-hover');
  await page.mouse.up();

  await expect.poll(() => patches.length, 'one PATCH for the move').toBe(1);
  expect(patches[0]).toEqual({
    id: 'ext-2026-09-09-stretch',
    fields: { date: '2026-09-10', start_time: '7:30 PM', end_time: '8:00 PM' },
  });
  await expect.poll(async () => (await eventState(page, 'ext-2026-09-09-stretch'))?.date).toBe('2026-09-10');
  expect(await eventState(page, 'ext-2026-09-09-stretch')).toMatchObject({ startTime: '7:30 PM', endTime: '8:00 PM' });
  // It now renders in the Thursday column at the new time, under its own translate no more.
  const moved = page.locator('.week-view__day-col[data-drop-date="2026-09-10"] .week-event[data-event-id="ext-2026-09-09-stretch"]');
  await expect(moved).toHaveCount(1);
  await expect(moved).not.toHaveClass(/week-event--dragging/);
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await shot(page, 'calendar-drag-week-dropped');
});
