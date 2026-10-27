import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

test('tracker starts a session and renders desktop + mobile', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });
  await shot(page, 'tracker-desktop');

  const ws = await apexState<{
    eventId: string; session: { started_at: string } | null; isFinished: boolean; elapsedSeconds: number;
  }>(page, 'workoutSession');
  expect(ws.session, 'session created (stubbed or in-memory)').toBeTruthy();
  expect(ws.isFinished).toBe(false);
  expect(ws.elapsedSeconds).toBeGreaterThanOrEqual(0);

  // Shadow fill: only present when set-tracked exercises have history
  // (stubbed when supabase env exists; absent in offline seed mode). The
  // ghost rides the placeholder; focusing the field commits it as the value.
  // Scope to one set row: seed workouts repeat aria-labels like "Set 1 time"
  // across exercises, so a page-wide label lookup is ambiguous. Pin the row
  // by index, not by a live :has(.tracker-input--shadow) filter — committing
  // the ghost drops the shadow class and a live filter would jump rows.
  const rows = page.locator('.tracker-set');
  const shadowRowIndex = await rows.evaluateAll(
    els => els.findIndex(el => el.querySelector('.tracker-input--shadow')),
  );
  if (shadowRowIndex >= 0) {
    const shadowRow = rows.nth(shadowRowIndex);
    const shadowInput = shadowRow.locator('.tracker-input--shadow').first();
    const label = await shadowInput.getAttribute('aria-label');
    const ghost = await shadowInput.getAttribute('placeholder');
    const input = shadowRow.locator(`[aria-label="${label}"]`);
    await expect(input).toHaveValue('');
    await input.click();
    await input.blur(); // DurationInput shows the committed value once blurred
    await expect(input).toHaveValue(ghost ?? '');
    await shot(page, 'tracker-shadow-committed');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.tracker-set').first()).toBeVisible();
  await shot(page, 'tracker-mobile');
});

test.describe('duration input', () => {
  test.use({ fakeNow: '2026-06-24T20:00:00' });

  test('fills a whole duration from one tap, stopwatch-style', async ({ page }) => {
    await gotoCalendar(page);
    await page.locator('.event-chip__main', { hasText: 'Stretch' }).first().click();
    await page.locator('.modal-completion__btn--start').click();

    const field = page.locator('.tracker-duration').first();
    await expect(field).toBeVisible({ timeout: 15000 });
    await shot(page, 'duration-stopwatch');

    // Digits fill right-to-left: 2,3,0 reads 0:02 → 0:23 → 2:30. One tap,
    // and the display shows exactly what will be stored at every keystroke.
    await field.click();
    await field.press('2');
    await expect(field).toHaveValue('0:02');
    await field.press('3');
    await expect(field).toHaveValue('0:23');
    await field.press('0');
    await expect(field).toHaveValue('2:30');
    await field.blur();
    await expect(field).toHaveValue('2:30');

    // Re-entry starts a fresh buffer (retype, not edit): the stored value
    // moves to the placeholder, and blurring untouched keeps it.
    await field.click();
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', '2:30');
    await field.blur();
    await expect(field).toHaveValue('2:30');

    // A bare digit is that many seconds — the live display disambiguates.
    await field.click();
    await field.press('2');
    await expect(field).toHaveValue('0:02');
    await field.blur();
    await expect(field).toHaveValue('2s');

    // Overflow stays literal while typing and rolls up on commit.
    await field.click();
    await field.pressSequentially('90');
    await expect(field).toHaveValue('0:90');
    await field.blur();
    await expect(field).toHaveValue('1:30');

    // Pasted colon values stay in stopwatch mode.
    await field.fill('2:30');
    await field.blur();
    await expect(field).toHaveValue('2:30');

    // Typing a letter auto-switches to free text, keeping the entry verbatim.
    await field.click();
    await field.pressSequentially('10s on 5s off');
    await field.blur();
    await expect(field).toHaveValue('10s on 5s off');
    await expect(field).toHaveAttribute('inputmode', 'text');

    // Clearing the field returns to stopwatch entry.
    await field.fill('');
    await expect(field).toHaveAttribute('inputmode', 'decimal');
    await expect(field).toHaveAttribute('placeholder', '0:00');
    await field.pressSequentially('45');
    await expect(field).toHaveValue('0:45');
    await field.blur();
    await expect(field).toHaveValue('45s');
  });
});

test('a missing dimension can be added mid-workout', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });

  // First exercise the plan gives no weight column — e.g. ring pull-ups
  // prescribed as "3 × 8". Pinned by index: once weight is added the
  // button leaves, and a live :has() filter would jump exercises.
  const exercises = page.locator('.tracker-exercise');
  const index = await exercises.evaluateAll(
    els => els.findIndex(el => el.querySelector('button[aria-label^="Track weight for"]')),
  );
  test.skip(index < 0, 'seed has no set-tracked exercise without a weight column');
  const exercise = exercises.nth(index);

  await expect(exercise.locator('.tracker-input--weight')).toHaveCount(0);
  await exercise.locator('button[aria-label^="Track weight for"]').click();
  await expect(exercise.locator('.tracker-input-label.tracker-input--weight')).toHaveText('weight');
  const firstWeight = exercise.locator('.tracker-set:not(.tracker-set--head)').first().locator('.tracker-input--weight');
  // Tap first, as a person does: a row with last session's ghost commits it
  // on focus, and an instant fill() would race that commit.
  await firstWeight.click();
  await expect(firstWeight).toBeFocused();
  await firstWeight.fill('10 lb');
  await expect(firstWeight).toHaveValue('10 lb');
  await expect(exercise.locator('button[aria-label^="Track weight for"]')).toHaveCount(0);
  await shot(page, 'tracker-added-weight');
});

test('a day-only note on an exercise sticks and reads back under its label', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  const exercise = page.locator('.tracker-exercise').first();
  await expect(exercise).toBeVisible({ timeout: 15000 });

  // With no notes the card's "+ note" chip opens the panel; with an every-time
  // note already there, the panel's own "note for today" does.
  await exercise
    .locator('button[aria-label^="Add a note on"]:not([aria-label$="for every workout"])')
    .first()
    .click();
  const panel = exercise.locator('.tracker-notes--open');
  await expect(panel.locator('.tracker-notes__label', { hasText: 'This workout only' })).toBeVisible();
  const note = panel.locator('textarea[aria-label$="for this workout only"]');
  await expect(note).toBeFocused();
  await note.fill('used the blue band');

  await panel.getByRole('button', { name: 'Done' }).click();
  // Closed, the note reads back under its label and is the way to edit it.
  const saved = exercise.locator('button[aria-label$="for this workout"]', { hasText: 'used the blue band' });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText('This workout only');
  await saved.click();
  await expect(exercise.locator('textarea[aria-label$="for this workout only"]')).toHaveValue('used the blue band');
  await shot(page, 'tracker-session-note');
});

test('a library movement offers both notes and the every-time one saves to the library', async ({ page }) => {
  // The mock library is empty; give the first seed exercise its definition so
  // the "Every time" section (which writes the definition) is offered.
  await page.route('**/exercise_definitions*', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify([{
        id: 'glute-squeeze-holds', canonical_name: 'Glute Squeeze Holds', aliases: [], category: 'strength',
        muscle_groups: [], equipment: [], image_url: null, technique_notes: null, is_unilateral: false,
        default_sets: null, default_reps: null, default_duration: null, default_weight: null, default_rest: null,
        log_fields: [], archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }]),
    });
  });
  const patches: { fields?: Record<string, unknown> }[] = [];
  page.on('request', req => {
    if (req.method() === 'PATCH' && req.url().includes('/api/exercise-definitions?id=glute-squeeze-holds')) {
      patches.push(req.postDataJSON());
    }
  });

  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  const exercise = page.locator('.tracker-exercise', { hasText: 'Glute Squeeze Holds' }).first();
  await expect(exercise).toBeVisible({ timeout: 15000 });

  await exercise.getByRole('button', { name: 'Add a note on Glute Squeeze Holds', exact: true }).click();
  const panel = exercise.locator('.tracker-notes--open');
  await expect(panel.locator('.tracker-notes__label', { hasText: 'Every time' })).toBeVisible();
  await expect(panel.locator('.tracker-notes__label', { hasText: 'This workout only' })).toBeVisible();
  await shot(page, 'tracker-notes-open');

  const every = panel.locator('textarea[aria-label$="for every workout"]');
  const saved = page.waitForRequest(req =>
    req.method() === 'PATCH' && req.url().includes('/api/exercise-definitions?id=glute-squeeze-holds'));
  await every.fill('  squeeze for a full two count  ');
  await panel.getByRole('button', { name: 'Done' }).click();
  expect((await saved).postDataJSON()?.fields?.technique_notes).toBe('squeeze for a full two count');

  // Closed, it reads back under its label, and the day-only kind is one tap away.
  const read = exercise.locator('button[aria-label$="every-time note on Glute Squeeze Holds"]');
  await expect(read).toContainText('Every time');
  await expect(read).toContainText('squeeze for a full two count');
  await expect(exercise.getByRole('button', { name: 'Add a note on Glute Squeeze Holds for this workout' })).toBeVisible();

  // Reopening and closing without a change writes nothing more.
  await read.click();
  await expect(exercise.locator('textarea[aria-label$="for every workout"]')).toBeFocused();
  await exercise.locator('.tracker-notes--open').getByRole('button', { name: 'Done' }).click();
  await expect(read).toBeVisible();
  expect(patches).toHaveLength(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'tracker-notes-mobile');
});

test('an exercise the plan lacks can be added mid-workout and removed again', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });
  const before = await page.locator('.tracker-exercise').count();

  await page.getByRole('button', { name: 'Add exercise' }).click();
  const picker = page.locator('.exercise-picker');
  await expect(picker).toBeVisible();
  // Climbing pitches need a grade the tracker can't ask for.
  await expect(picker.locator('.library-filter', { hasText: /^climbing$/i })).toHaveCount(0);
  // The seed library may not have it — the picker's own create path adds it.
  const name = 'Push-Up';
  await picker.locator('.exercise-picker__input').fill(name);
  const existing = picker.locator('.exercise-picker__row', { hasText: name }).first();
  if (await existing.count()) await existing.click();
  else {
    await picker.getByRole('button', { name: `Create "${name}" as a new exercise` }).click();
    await picker.getByRole('button', { name: 'Create & add' }).click();
  }

  const added = page.locator('.tracker-exercise').last();
  await expect(page.locator('.tracker-exercise')).toHaveCount(before + 1);
  await expect(added.locator('.tracker-exercise__name')).toHaveText(name);
  await expect(added).toContainText('Added to this workout — the plan is unchanged.');

  // Typing saves it under its own id, as an ordinary set row.
  const saved = page.waitForRequest(req => req.url().includes('/api/workout-sessions')
    && req.postDataJSON()?.action === 'save'
    && (req.postDataJSON()?.setLogs ?? []).some((r: { exercise_id: string }) => r.exercise_id.startsWith('added-')));
  const reps = added.locator('input.tracker-input--reps').first();
  await reps.click();
  await reps.fill('20');
  const row = (await saved).postDataJSON().setLogs.find((r: { exercise_id: string }) => r.exercise_id.startsWith('added-'));
  expect(row).toMatchObject({ exercise_name: name, set_number: 1, actual_reps: '20', planned_reps: null });
  await shot(page, 'tracker-added-exercise');

  const removed = page.waitForRequest(req => req.url().includes('/api/workout-sessions')
    && req.postDataJSON()?.action === 'save'
    && (req.postDataJSON()?.removedSets ?? []).some((k: { exerciseId: string }) => k.exerciseId === row.exercise_id));
  await added.getByRole('button', { name: `Remove ${name} from this workout` }).click();
  await expect(page.locator('.tracker-exercise')).toHaveCount(before);
  await removed;
});
