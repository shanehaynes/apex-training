import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** See builder-create.spec.ts — one POST per save, and nothing else. */
function watchDraftWrites(page: Page) {
  const drafts: Array<Record<string, unknown>> = [];
  const legacy: string[] = [];
  page.on('request', req => {
    const { pathname } = new URL(req.url());
    if (pathname === '/api/workout-draft') drafts.push(req.postDataJSON());
    else if (req.method() !== 'GET' && ['/api/events', '/api/event-instances', '/api/workout-templates'].includes(pathname)) {
      legacy.push(`${req.method()} ${pathname}`);
    }
  });
  return { drafts, legacy };
}

interface StateEvent {
  id: string;
  title: string;
  date: string;
  isRecurring: boolean;
  recurrenceRule?: string;
}

const stateEvents = (page: Page) =>
  apexState<{ events: StateEvent[] }>(page, 'schedule').then(s => s.events);

test('repeat picker serializes a weekly rule and snaps the anchor date', async ({ page }) => {
  const wire = watchDraftWrites(page);
  await gotoCalendar(page);

  await page.getByTestId('nav-add-workout').click();
  await page.locator('.builder-search__create').click();
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill('Repeat Spec');

  // Off by default; a dayless repeat is refused — server-side since #136, so
  // the refusal costs one POST and arrives as a toast.
  const repeatSwitch = page.locator('.builder-repeat__switch');
  await expect(repeatSwitch).toHaveText('Off');
  await repeatSwitch.click();
  await page.locator('.exercise-editor__save').click();
  await expect(page.getByText('at least one day').first()).toBeVisible();

  // Mondays and Wednesdays, every 2 weeks.
  await page.getByLabel('Repeat on MO').click();
  await page.getByLabel('Repeat on WE').click();
  await page.locator('.builder-repeat__interval-input').fill('2');
  await shot(page, 'builder-repeat');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  // The wire carries the picker's state, not a rule — serializing it is the
  // server's job (ruleFromRepeat + snapAnchorDate inside createInputFromDraft).
  expect(wire.drafts.length, 'the refused Apply plus the accepted one').toBe(2);
  const repeat = (wire.drafts[1].draft as { repeat: { enabled: boolean; days: string[]; interval: string } }).repeat;
  expect(repeat.enabled).toBe(true);
  expect([...repeat.days].sort()).toEqual(['MO', 'WE']);
  expect(repeat.interval).toBe('2');
  expect(wire.legacy, 'no POST /api/events').toEqual([]);

  // What came back is what matters: the created series is placed locally, so
  // the rule and the snapped anchor are assertable on the calendar itself.
  // The engine renders the anchor at its own date, so a stray weekday there
  // would put an occurrence on a day the user never picked.
  const series = (await stateEvents(page)).filter(e => e.title === 'Repeat Spec');
  expect(series.length, 'the new series expanded onto the calendar').toBeGreaterThan(0);
  expect(series[0].recurrenceRule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  expect(series.every(e => e.isRecurring)).toBe(true);
  expect(
    series.map(e => weekdayOf(e.date)).filter(d => d !== 1 && d !== 3),
    'every occurrence lands on a Monday or a Wednesday',
  ).toEqual([]);
});

test('editing a recurring occurrence asks for scope: series updates, this day detaches', async ({ page }) => {
  const wire = watchDraftWrites(page);
  await gotoCalendar(page);

  // Find a recurring occurrence whose rule the picker can express (the seed
  // also holds legacy-pattern series, which render the card read-only).
  const recurring = (await stateEvents(page)).find(e =>
    e.isRecurring && e.recurrenceRule?.startsWith('FREQ=WEEKLY;BYDAY='));
  expect(recurring, 'the bundled seed has a weekly recurring event').toBeTruthy();
  const baseId = recurring!.id.split('__')[0];
  const seriesDates = async () => (await stateEvents(page))
    .filter(e => e.id.split('__')[0] === baseId).map(e => e.date).sort();
  const datesBefore = await seriesDates();

  await page.locator('.event-chip__main', { hasText: recurring!.title }).first().click();
  await page.locator('.modal-edit-workout').click();

  // The repeat card reflects the live series rule, with no off switch.
  await expect(page.locator('.builder-repeat__day--active').first()).toBeVisible();
  await expect(page.locator('.builder-repeat__switch')).toHaveCount(0);

  // ── Whole-series save ──
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill('Series Renamed');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.builder-scope__question')).toBeVisible();
  await shot(page, 'builder-scope-chooser');
  await page.locator('.exercise-editor__save', { hasText: 'Whole series' }).click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  expect(wire.drafts.length, 'one POST for the series save').toBe(1);
  const update = wire.drafts[0].action as { kind: string; eventId: string };
  expect(update.kind).toBe('update');
  expect(update.eventId.split('__')[0], 'addressed by the occurrence the modal opened').toBe(baseId);

  // A series save must move nothing: the server drops the schedule fields so
  // the anchor cannot follow whichever occurrence happened to be open. The
  // draft carries a date regardless, which is exactly why this is asserted on
  // the result rather than on the request.
  expect(await seriesDates(), 'a series save carries no schedule change').toEqual(datesBefore);
  const renamed = (await stateEvents(page)).filter(e => e.id.split('__')[0] === baseId);
  expect(renamed.every(e => e.title === 'Series Renamed'), 'every occurrence followed').toBe(true);
  expect(renamed[0].recurrenceRule, 'weekly rule rewritten series-wide').toContain('FREQ=WEEKLY');

  // ── This-event-only save ──
  // Reopening by the renamed chip only works because the update was placed
  // locally rather than awaited from a realtime refetch.
  await page.locator('.event-chip__main', { hasText: 'Series Renamed' }).first().click();
  await page.locator('.modal-edit-workout').click();
  await page.locator('.library-field', { hasText: 'Location' }).locator('input').fill('Detached gym');
  await page.locator('.exercise-editor__save').click();
  await page.locator('.exercise-editor__save', { hasText: 'This day only' }).click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  expect(wire.drafts.length, 'one POST per save, still').toBe(2);
  expect(Object.keys(wire.drafts[1]).sort(), 'no occurrenceDate on the wire').toEqual(['action', 'draft', 'today']);
  const detach = wire.drafts[1].action as { kind: string; eventId: string };
  expect(detach.kind).toBe('detach');
  expect(detach.eventId.split('__')[0]).toBe(baseId);
  expect((wire.drafts[1].draft as { location: string }).location).toBe('Detached gym');

  // The day left the series for good: a standalone, never-recurring event
  // with a fresh id — never an occurrence id.
  const standalone = (await stateEvents(page)).filter(e => !e.isRecurring && e.title === 'Series Renamed');
  expect(standalone.length, 'exactly one standalone event').toBe(1);
  expect(standalone[0].id).not.toContain('__');
  expect(standalone[0].id.split('__')[0]).not.toBe(baseId);
  expect(wire.legacy, 'neither save touched the old endpoints').toEqual([]);
});
