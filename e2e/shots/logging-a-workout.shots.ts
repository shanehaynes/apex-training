// Screenshots for help/logging-a-workout.md. Run:
//
//   APEX_PORT=<port> npx playwright test --project=shots-phone --project=shots-desktop \
//     e2e/shots/logging-a-workout.shots.ts
//
// One plain workout replaces the bundled seed (whose warm-ups bury the main
// lifts below the fold), with last session's numbers a little under today's
// plan so the grey ghosts read as believable history. 01–05 are phone shots;
// 06 is the desktop tracker.

import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';
// @ts-expect-error plain-JS helper shared with the intercept
import { mockSession, sessionResponse } from '../lib/intercept.mjs';
import { rowToEvent } from '../../src/lib/schedule/mapping';
import { buildLastPerformance, buildTrackerModel } from '../../src/lib/tracking/plan';
import type { PersonalRecord } from '../../src/lib/tracking/records';

const SLUG = 'logging-a-workout';
const TODAY = '2026-09-07'; // playwright.config.ts FAKE_NOW
const LAST_TIME = '2026-08-31';

const EVENT_ROW = {
  id: 'evt-upper',
  type: 'weights',
  title: 'Upper Body',
  subtitle: null,
  date: TODAY,
  start_time: '6:00 PM',
  end_time: '7:00 PM',
  estimated_duration: 60,
  description: 'Press, pull, row. Rest two minutes between heavy sets.',
  warmup: [],
  exercises: [
    { id: 'ex-bench', name: 'Bench Press', category: 'strength', sets: 3, reps: '8', weight: '135 lbs', restPeriod: '2 min' },
    { id: 'ex-pullup', name: 'Pull-Ups', category: 'strength', sets: 3, reps: '8' },
    { id: 'ex-row', name: 'Dumbbell Row', category: 'strength', sets: 3, reps: '10', weight: '50 lbs' },
  ],
  cooldown: [],
  difficulty: 3,
  location: null,
  cover_image_url: null,
  cardio_targets: null,
  climbing_targets: null,
  tags: [],
  equipment: [],
  is_recurring: false,
  recurrence_rule: null,
  recurring_frequency: null,
  recurring_days: null,
  recurring_end_date: null,
  source: null,
  sport: null,
  template_id: null,
  scoring_type: null,
  time_cap_minutes: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

/** Last session: a touch under today's plan, every set logged. */
const HISTORY = ([
  ['Bench Press', '130', '8'],
  ['Pull-Ups', '', '8'],
  ['Dumbbell Row', '45', '10'],
] as const).flatMap(([name, weight, reps], i) => [1, 2, 3].map(setNumber => ({
  event_id: 'evt-upper-prev', event_date: LAST_TIME, section: 'exercise',
  exercise_id: `prev-${i}`, exercise_name: name, set_number: setNumber,
  planned_weight: null, planned_reps: null, planned_duration: null,
  actual_weight: weight || null, actual_reps: reps, actual_duration: null,
  is_autofilled: false,
})));

/** What the server would find beating that history (the summary's trophies). */
const PRS: PersonalRecord[] = [
  { kind: 'oneRM', exerciseName: 'Bench Press', estimatedOneRM: 171, weight: 135, reps: 8, previousOneRM: 165, previousDate: LAST_TIME },
  { kind: 'reps', exerciseName: 'Pull-Ups', reps: 10, previousReps: 8, previousDate: LAST_TIME },
];

const COACH_NDJSON =
  JSON.stringify({ type: 'text', delta: 'Every set logged, and the bench moved up five pounds. Keep the rest at two minutes.' }) + '\n' +
  JSON.stringify({ type: 'done' }) + '\n';

async function stubWorkout(page: Page) {
  const event = rowToEvent(EVENT_ROW as never);
  await page.route(/rest\/v1\/workout_events/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([EVENT_ROW]) }));
  await page.route('**/api/coach-summary*', route =>
    route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: COACH_NDJSON }));
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const reply = (json: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
    if (body.action === 'bootstrap') {
      const groups = buildTrackerModel(event, [], [], buildLastPerformance(HISTORY as never), new Map());
      return reply({ session: mockSession(), event, groups, scored: false, prs: [], scoreRecord: null });
    }
    if (body.action === 'finish') {
      return reply({ ok: true, totalDurationSeconds: 3120, prs: PRS, scoreRecord: null, recap: '' });
    }
    return reply(sessionResponse(body, { session: mockSession(), event }));
  });
}

/** Phone: the day view opens on today; open the workout's card. */
async function openWorkoutOnPhone(page: Page) {
  await page.goto('/');
  await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.day-view').getByRole('button', { name: /^Open .*Upper Body/ }).first().click();
  await expect(page.getByRole('button', { name: 'Start Workout' })).toBeVisible();
}

async function startOnPhone(page: Page) {
  await openWorkoutOnPhone(page);
  await page.getByRole('button', { name: 'Start Workout' }).click();
  await expect(page.locator('.tracker-input--shadow').first()).toBeVisible({ timeout: 15000 });
}

/** The set rows of one exercise card (the header row excluded). */
const setRows = (page: Page, exercise: string) =>
  page.locator('.tracker-exercise', { hasText: exercise }).locator('.tracker-set:not(.tracker-set--head)');

test.describe('phone', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'shots-phone', 'phone shots');
    await stubWorkout(page);
  });

  test('01 the workout card: Start Workout or Mark as Complete', async ({ page }) => {
    await openWorkoutOnPhone(page);
    await helpShot(page, { slug: SLUG, n: 1, name: 'start-or-mark', highlight: page.locator('.modal-completion') });
  });

  test('02–04 grey numbers, one set typed, the unlogged bar', async ({ page }) => {
    await startOnPhone(page);
    const bench = setRows(page, 'Bench Press');
    await helpShot(page, { slug: SLUG, n: 2, name: 'grey-numbers', highlight: bench.first().locator('.tracker-set__inputs') });

    // Tap set 1's weight: last time's 130 × 8 becomes this set's value, selected,
    // so typing replaces the weight and keeps the reps.
    const weight = bench.first().getByRole('textbox', { name: 'Set 1 weight' });
    await weight.click();
    await expect(weight).toHaveValue('130');
    await weight.pressSequentially('135');
    await weight.blur();
    await expect(weight).toHaveValue('135');
    await expect(bench.nth(1).locator('.tracker-input--shadow').first()).toBeVisible();
    await helpShot(page, { slug: SLUG, n: 3, name: 'one-set-typed', highlight: bench.first().locator('.tracker-set__inputs') });

    await page.locator('.tracker-header__finish').click();
    const bar = page.locator('.tracker-confirm');
    await expect(bar).toContainText('unlogged');
    await expect(bar.getByRole('button', { name: 'Keep going' })).toBeVisible();
    await helpShot(page, { slug: SLUG, n: 4, name: 'unlogged-bar', highlight: bar });
  });

  test('05 the summary with trophies', async ({ page }) => {
    await startOnPhone(page);
    // Log everything: tapping a grey set keeps it; typing over it changes it.
    // Bench goes up to 135 and pull-ups to 10 — the two trophies PRS stubs.
    const typed: Record<string, string | undefined> = { 'Bench Press': '135', 'Pull-Ups': '10' };
    for (const exercise of ['Bench Press', 'Pull-Ups', 'Dumbbell Row']) {
      const rows = setRows(page, exercise);
      for (let i = 0; i < 3; i++) {
        const first = rows.nth(i).locator('.tracker-input').first();
        await first.click();
        const value = typed[exercise];
        if (value) await first.pressSequentially(value);
        await first.blur();
      }
    }
    await page.locator('.tracker-header__finish').click();
    const summary = page.locator('.tracker-summary');
    await expect(summary).toBeVisible();
    await expect(summary.locator('.tracker-summary__pr')).toHaveCount(2);
    await expect(summary.locator('.tracker-summary__coach-text')).toContainText('bench moved up');
    await helpShot(page, { slug: SLUG, n: 5, name: 'summary-trophies', highlight: summary.locator('.tracker-summary__prs') });
  });
});

test.describe('desktop', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'shots-desktop', 'desktop shot');
    await stubWorkout(page);
  });

  test('06 the tracker on a computer', async ({ page }) => {
    await gotoCalendar(page);
    await page.locator('.event-chip__main', { hasText: 'Upper Body' }).first().click();
    await page.getByRole('button', { name: 'Start Workout' }).click();
    await expect(page.locator('.tracker-input--shadow').first()).toBeVisible({ timeout: 15000 });
    // The pointer is still where Start Workout was — over the first Add set,
    // which it would show hovered. Park it in the empty margin.
    await page.mouse.move(150, 600);
    await helpShot(page, { slug: SLUG, n: 6, name: 'tracker', highlight: page.locator('.tracker-header__finish') });
  });
});
