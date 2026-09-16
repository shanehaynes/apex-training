import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

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

test('edit workout opens the builder prefilled; save posts one update', async ({ page }) => {
  const wire = watchDraftWrites(page);
  await gotoCalendar(page);

  // A one-off event — recurring ones detour through the series scope chooser
  // (covered by builder-recurrence.spec.ts).
  const schedule = await apexState<{ events: Array<{ id: string; title: string; isRecurring: boolean }> }>(page, 'schedule');
  const oneOff = schedule.events.find(e => !e.isRecurring);
  expect(oneOff, 'the bundled seed has a one-off event').toBeTruthy();
  await page.locator('.event-chip__main', { hasText: oneOff!.title }).first().click();
  const originalTitle = (await page.locator('.modal-title').textContent())!.trim();
  await page.locator('.modal-edit-workout').click();
  await expect(page.locator('.modal'), 'builder replaces the workout modal').toHaveCount(0);
  await expect(page.locator('.builder-search'), 'edit mode skips the search step').toHaveCount(0);
  await expect(page.locator('.composer-form')).toBeVisible();

  const title = page.locator('.library-field', { hasText: 'Title' }).locator('input');
  await expect(title).toHaveValue(originalTitle);
  await shot(page, 'builder-edit-prefilled');

  // Every field is editable here — the piecemeal modal never offered these.
  await title.fill('Edited In Builder');
  await page.locator('.library-field', { hasText: 'Location' }).locator('input').fill('Garage gym');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  // One POST carrying the whole draft: the server derives the PATCH fields
  // from it (eventFieldsFromDraft), so nothing field-shaped is on this wire.
  expect(wire.drafts.length, 'exactly one POST').toBe(1);
  const body = wire.drafts[0];
  expect(Object.keys(body).sort()).toEqual(['action', 'draft', 'today']);
  // Addressed by the row the modal opened. Several seed events share a title,
  // so this pins the shape — a one-off is addressed by its own base id, never
  // an occurrence id — rather than one particular seed row.
  const action = body.action as { kind: string; eventId: string };
  expect(action.kind).toBe('update');
  expect(action.eventId, 'a one-off has no occurrence id').not.toContain('__');
  expect(
    schedule.events.some(e => e.id === action.eventId && !e.isRecurring),
    'the id belongs to a one-off event on the calendar',
  ).toBe(true);
  const draft = body.draft as Record<string, unknown>;
  expect(draft.title).toBe('Edited In Builder');
  expect(draft.location).toBe('Garage gym');
  expect(wire.legacy, 'no PATCH /api/events').toEqual([]);

  // The response REPLACES the base event locally, so the calendar renames
  // without waiting on a refetch.
  await expect(page.locator('.event-chip__main', { hasText: 'Edited In Builder' }).first()).toBeVisible();
  await shot(page, 'builder-edit-saved');
});
