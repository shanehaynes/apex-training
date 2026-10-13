import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

// "Save exercises" on a series occurrence asks This day only / Whole series,
// the way Edit workout does. Whole series is the PATCH the modal always
// made; This day only is the builder's detach, carrying the exercises, and
// the modal follows the standalone event. A one-off never sees the chooser.

interface StateEvent {
  id: string;
  title: string;
  date: string;
  isRecurring: boolean;
}

const stateEvents = (page: Page) =>
  apexState<{ events: StateEvent[] }>(page, 'schedule').then(s => s.events);

/** Every write out of the editor: PATCH /api/events and POST /api/workout-draft. */
function watchWrites(page: Page) {
  const patches: Array<{ id: string | null; body: Record<string, unknown> }> = [];
  const drafts: Array<Record<string, unknown>> = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.pathname === '/api/events' && req.method() === 'PATCH') {
      patches.push({ id: url.searchParams.get('id'), body: req.postDataJSON() });
    } else if (url.pathname === '/api/workout-draft') {
      drafts.push(req.postDataJSON());
    }
  });
  return { patches, drafts };
}

const cards = (page: Page) => page.locator('.modal-body .exercise-card');
const editorCards = (page: Page) => page.locator('.editor-card');

async function openEditor(page: Page) {
  await page.locator('.modal-edit-exercises').click();
  await expect(editorCards(page).first()).toBeVisible();
}

/** Drop the first card and press Save; returns how many cards the save carries. */
async function removeFirstAndSave(page: Page) {
  const before = await editorCards(page).count();
  await page.locator('.editor-card__remove').first().click();
  await expect(editorCards(page)).toHaveCount(before - 1);
  await page.locator('.exercise-editor__save', { hasText: 'Save exercises' }).click();
  return before - 1;
}

test('a series occurrence asks for scope: whole series patches the base, this day detaches', async ({ page }) => {
  const wire = watchWrites(page);
  await gotoCalendar(page);

  const recurring = (await stateEvents(page)).find(e => e.isRecurring);
  expect(recurring, 'the bundled seed has a recurring event').toBeTruthy();
  const baseId = recurring!.id.split('__')[0];
  const chips = page.locator('.event-chip__main', { hasText: recurring!.title });
  expect(await chips.count(), 'the series expands onto more than one day').toBeGreaterThan(1);

  await chips.first().click();
  const occurrenceId = (await apexState<{ selectedEventId: string }>(page, 'calendar')).selectedEventId;
  expect(occurrenceId.split('__')[0]).toBe(baseId);
  // The chip the view shows first is not necessarily the state's first
  // occurrence — the day actually opened is what the detach must keep.
  const opened = (await stateEvents(page)).find(e => e.id === occurrenceId);
  expect(opened, 'the opened occurrence is on the calendar').toBeTruthy();
  const cardsAtStart = await cards(page).count();

  // ── Whole series ──
  await openEditor(page);
  await expect(page.locator('.exercise-editor__series-note')).toContainText('this day only or the whole series');
  const afterSeries = await removeFirstAndSave(page);
  await expect(page.locator('.builder-scope__question')).toBeVisible();
  await expect(page.locator('.builder-scope__question'))
    .toContainText('leaves the series for good, keeping anything logged');
  expect(wire.patches, 'nothing is written until a scope is chosen').toEqual([]);
  await shot(page, 'edit-exercises-scope-chooser');

  // Back returns to the editor with the edit intact.
  await page.locator('.exercise-editor__cancel', { hasText: 'Back' }).click();
  await expect(page.locator('.builder-scope__question')).toHaveCount(0);
  await expect(editorCards(page)).toHaveCount(afterSeries);
  await page.locator('.exercise-editor__save', { hasText: 'Save exercises' }).click();
  await page.locator('.exercise-editor__save', { hasText: 'Whole series' }).click();

  await expect(page.locator('.exercise-editor')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(afterSeries);
  expect(wire.patches.length, 'one PATCH for the series').toBe(1);
  expect(wire.patches[0].id, 'addressed to the base event, never the occurrence').toBe(baseId);
  expect(wire.drafts, 'no detach').toEqual([]);
  expect(await stateEvents(page), 'every occurrence is still in the series')
    .toEqual(expect.not.arrayContaining([expect.objectContaining({ title: recurring!.title, isRecurring: false })]));

  // Another day of the series carries the change.
  await page.locator('.modal-close').click();
  await chips.nth(1).click();
  await expect(cards(page)).toHaveCount(afterSeries);
  await page.locator('.modal-close').click();

  // ── This day only ──
  await chips.first().click();
  await openEditor(page);
  const afterDetach = await removeFirstAndSave(page);
  await expect(page.locator('.builder-scope__question')).toBeVisible();
  // The chooser remembers the last choice as its default.
  await expect(page.locator('.exercise-editor__save[data-default]')).toHaveText('Whole series');
  await page.locator('.exercise-editor__save', { hasText: 'This day only' }).click();

  await expect(page.locator('.exercise-editor')).toHaveCount(0);
  expect(wire.drafts.length, 'one detach POST').toBe(1);
  expect(wire.patches.length, 'and no PATCH for it').toBe(1);
  const action = wire.drafts[0].action as { kind: string; eventId: string };
  expect(action.kind).toBe('detach');
  expect(action.eventId).toBe(occurrenceId);
  const draft = wire.drafts[0].draft as { lists: { warmup: unknown[]; exercises: unknown[]; cooldown: unknown[] } };
  expect(
    draft.lists.warmup.length + draft.lists.exercises.length + draft.lists.cooldown.length,
    'the detach carries the edited exercises',
  ).toBe(afterDetach);

  // The modal stays open on the standalone event: a fresh, never-recurring
  // id with the edited exercises, while the occurrence left the series.
  await expect(page.locator('.modal')).toBeVisible();
  const selected = (await apexState<{ selectedEventId: string }>(page, 'calendar')).selectedEventId;
  expect(selected).not.toContain('__');
  expect(selected.split('__')[0]).not.toBe(baseId);
  const events = await stateEvents(page);
  const standalone = events.find(e => e.id === selected);
  expect(standalone, 'the standalone event is on the calendar').toBeTruthy();
  expect(standalone!.isRecurring).toBe(false);
  expect(standalone!.title).toBe(recurring!.title);
  expect(standalone!.date, 'the detached day keeps its date').toBe(opened!.date);
  expect(events.some(e => e.id === occurrenceId), 'the occurrence id no longer expands').toBe(false);
  await expect(cards(page)).toHaveCount(afterDetach);
  await shot(page, 'edit-exercises-scope-detached');

  // The standalone is a one-off now: the next save asks nothing and PATCHes it.
  await openEditor(page);
  await expect(page.locator('.exercise-editor__series-note')).toHaveCount(0);
  const afterOneOff = await removeFirstAndSave(page);
  await expect(page.locator('.exercise-editor')).toHaveCount(0);
  expect(wire.patches.length).toBe(2);
  expect(wire.patches[1].id).toBe(selected);
  await expect(cards(page)).toHaveCount(afterOneOff);

  // The rest of the series kept the whole-series edit and nothing else.
  await page.locator('.modal-close').click();
  await chips.nth(1).click();
  await expect(cards(page)).toHaveCount(afterSeries);
  expect(cardsAtStart - afterSeries).toBe(1);
});

test('a one-off never sees the chooser', async ({ page }) => {
  const wire = watchWrites(page);
  await gotoCalendar(page);

  const oneOff = (await stateEvents(page)).find(e => !e.isRecurring);
  expect(oneOff, 'the bundled seed has a one-off event').toBeTruthy();
  await page.locator('.event-chip__main', { hasText: oneOff!.title }).first().click();
  await openEditor(page);
  await expect(page.locator('.exercise-editor__series-note')).toHaveCount(0);
  const after = await removeFirstAndSave(page);

  await expect(page.locator('.builder-scope__question')).toHaveCount(0);
  await expect(page.locator('.exercise-editor')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(after);
  expect(wire.patches.length).toBe(1);
  expect(wire.patches[0].id).not.toContain('__');
  expect(wire.drafts).toEqual([]);
});
