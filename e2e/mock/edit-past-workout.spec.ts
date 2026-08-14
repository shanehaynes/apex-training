import { test, expect, apexState, gotoCalendar, shot, supabaseRef } from '../lib/fixtures';

interface ScheduleState { eventCount: number }

test('a workout can be deleted from its modal, after a confirm', async ({ page }) => {
  await gotoCalendar(page);
  const before = (await apexState<ScheduleState>(page, 'schedule')).eventCount;

  await page.locator('.event-chip__main').first().click();
  await expect(page.locator('.modal-completion__btn--start')).toBeVisible();

  // Delete asks first — one click never removes a workout.
  await page.locator('.modal-delete').click();
  await expect(page.locator('.modal-danger__text')).toBeVisible();
  await shot(page, 'delete-workout-confirm');

  // Keep backs out with the workout untouched.
  await page.locator('.modal-danger__btn', { hasText: 'Keep' }).click();
  await expect(page.locator('.modal-delete')).toBeVisible();
  expect((await apexState<ScheduleState>(page, 'schedule')).eventCount).toBe(before);

  await page.locator('.modal-delete').click();
  // "Delete workout" on a one-off, "This day only" on a recurring occurrence.
  await page.locator('.modal-danger__btn--danger').first().click();

  // Offline (no Supabase env) every write fails by design — the modal stays
  // open and says so, which is the honest offline behaviour.
  if (!supabaseRef()) {
    await expect(page.getByText('Failed to delete').first()).toBeVisible();
    return;
  }

  await expect(page.locator('.modal-backdrop'), 'the modal closes once the workout is gone').toHaveCount(0);
  await expect
    .poll(async () => (await apexState<ScheduleState>(page, 'schedule')).eventCount)
    .toBe(before - 1);
  await shot(page, 'delete-workout-done');
});

test('a finished workout keeps logging edits — reps and weights stay editable', async ({ page }) => {
  const saved: { setLogs?: { actual_reps?: string | null; actual_weight?: string | null }[] }[] = [];

  // Outranks the context-level stub: report the session as finished so the
  // tracker renders its post-finish state, and capture what autosave sends.
  await page.route('**/api/workout-sessions**', async route => {
    const body = route.request().postDataJSON() ?? {};
    if (body.action === 'save') saved.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body.action === 'start'
        ? {
            session: {
              id: 'finished-session', event_id: body.eventId, event_date: body.eventDate,
              started_at: '2026-09-07T08:00:00.000Z', finished_at: '2026-09-07T09:00:00.000Z',
              total_duration_seconds: 3600, coach_summary: null, updated_at: '',
            },
          }
        : { ok: true }),
    });
  });

  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();

  // The header reads "Done" on a finished session — the note is what tells
  // the user the inputs below it are still live.
  await expect(page.locator('.tracker-finished-note')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.tracker-header__done-badge')).toBeVisible();
  await shot(page, 'tracker-finished-editable');

  // A plain reps/weight field, not a DurationInput — those reformat as you
  // type (see the duration spec) and would obscure what was actually saved.
  const input = page.locator('input.tracker-input--weight, input.tracker-input--reps').first();
  await expect(input).toBeVisible();
  // Click first: focusing a row with a last-session ghost commits that ghost
  // as the value, and fill() would type on top of it.
  await input.click();
  await input.fill('137');
  await expect(input).toHaveValue('137');

  // Autosave is debounced (800 ms) — the edit reaches the server on its own.
  await expect.poll(() => saved.length, { timeout: 10000 }).toBeGreaterThan(0);
  const values = saved.flatMap(s => s.setLogs ?? []).flatMap(r => [r.actual_reps, r.actual_weight]);
  expect(values, 'the edited value is what gets persisted').toContain('137');
});
