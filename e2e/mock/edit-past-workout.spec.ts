import type { Page } from '@playwright/test';
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

interface SwapBody {
  action?: string;
  section?: string;
  exerciseId?: string;
  exerciseName?: string;
  definitionId?: string | null;
}

/** Report the session finished and capture any swap the tracker posts. */
async function stubFinishedSession(page: Page, swaps: SwapBody[]) {
  await page.route('**/api/workout-sessions**', async route => {
    const body = (route.request().postDataJSON() ?? {}) as SwapBody;
    if (body.action === 'swap-exercise') swaps.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body.action === 'start'
        ? {
            session: {
              id: 'finished-session', event_id: 'e', event_date: '2026-09-07',
              started_at: '2026-09-07T08:00:00.000Z', finished_at: '2026-09-07T09:00:00.000Z',
              total_duration_seconds: 3600, coach_summary: null, updated_at: '',
            },
          }
        : { ok: true }),
    });
  });
}

/**
 * A two-entry exercise library, outranking the context-level stub that serves
 * an empty one. Without it the picker has nothing to offer and the swap can
 * never be driven end to end here. Single-arm DB press is unilateral on
 * purpose — swapping onto it is what should raise the per-side reps warning.
 */
async function stubLibrary(page: Page) {
  const definition = (id: string, name: string, isUnilateral: boolean) => ({
    id, canonical_name: name, aliases: [], category: 'strength',
    muscle_groups: ['chest'], equipment: [], image_url: null, technique_notes: null,
    is_unilateral: isUnilateral, default_sets: 3, default_reps: isUnilateral ? '8 each arm' : '8',
    default_duration: null, default_weight: null, default_rest: null, archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  await page.route('**/exercise_definitions*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      definition('def-db-press', 'Single-Arm Dumbbell Press', true),
      definition('def-push-up', 'Push-Up', false),
    ]),
  }));
}

async function openFinishedTracker(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise').first()).toBeVisible({ timeout: 15000 });
}

test('the swap picker only offers movements that log the same shape', async ({ page }) => {
  await stubFinishedSession(page, []);
  await openFinishedTracker(page);

  await page.locator('.tracker-exercise').first().locator('.tracker-exercise__swap').click();
  await expect(page.locator('.exercise-picker')).toBeVisible();

  // Cardio logs one structured row where set work logs per-set rows, so
  // offering it here would strand the sets it replaced.
  await expect(page.locator('.library-filter', { hasText: 'Cardio' })).toHaveCount(0);
  await expect(page.locator('.library-filter', { hasText: 'Strength' })).toBeVisible();
});

test('a logged exercise can be swapped for the movement actually performed', async ({ page }) => {
  const swaps: SwapBody[] = [];
  await stubLibrary(page);
  await stubFinishedSession(page, swaps);
  await openFinishedTracker(page);

  const exercise = page.locator('.tracker-exercise').first();
  const plannedName = (await exercise.locator('.tracker-exercise__name').textContent())?.trim();
  expect(plannedName).toBeTruthy();

  await exercise.locator('.tracker-exercise__swap').click();
  await expect(page.locator('.exercise-picker__row').first()).toBeVisible();
  await page.locator('.exercise-picker__row', { hasText: 'Single-Arm Dumbbell Press' }).click();
  await expect(page.locator('.exercise-picker')).toHaveCount(0);

  // The tracker renames in place and says what the logs used to be filed under.
  await expect(exercise.locator('.tracker-exercise__name')).toHaveText('Single-Arm Dumbbell Press');
  await expect(exercise.locator('.tracker-exercise__swapped')).toContainText(plannedName!);
  await shot(page, 'tracker-exercise-swapped');

  if (!supabaseRef()) return; // offline every write is a no-op by design

  await expect.poll(() => swaps.length, { timeout: 10000 }).toBeGreaterThan(0);
  expect(swaps[0]).toMatchObject({
    action: 'swap-exercise',
    exerciseName: 'Single-Arm Dumbbell Press',
    definitionId: 'def-db-press',
  });
  expect(swaps[0].exerciseId, 'the entry id is what logs key on — it must not move').toBeTruthy();
});

test('swapping onto a unilateral movement warns that the reps are now per side', async ({ page }) => {
  await stubLibrary(page);
  await stubFinishedSession(page, []);
  await openFinishedTracker(page);

  // The first exercise that logs reps at all — the warm-up leading the day is
  // often a duration-only stretch.
  const exercise = page.locator('.tracker-exercise')
    .filter({ has: page.locator('input.tracker-input--reps') })
    .first();
  // A bare rep count, entered against the bilateral movement being replaced.
  const reps = exercise.locator('input.tracker-input--reps').first();
  await reps.click();
  await reps.fill('10');

  await exercise.locator('.tracker-exercise__swap').click();
  await expect(page.locator('.exercise-picker__row').first()).toBeVisible();
  await page.locator('.exercise-picker__row', { hasText: 'Single-Arm Dumbbell Press' }).click();

  await expect(exercise.locator('.tracker-exercise__notes--warn')).toContainText('per side');
  await shot(page, 'tracker-exercise-swapped-unilateral');
});
