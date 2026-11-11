import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';
import { buildLastPerformance, buildTrackerModel, type TrackedSectionGroup } from '../../src/lib/tracking/plan';
import { attachQuarterBests, quarterStartOf } from '../../src/lib/tracking/records';
import type { SetLogRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

// A strength exercise's target column shows its best set this quarter
// (docs/specs/tracker-quarter-pr): the quarter in the heading, the set on the
// first row only, one field at a time with a fade between them. The stub
// stands in for the server with the same pure builders, over history this
// spec fabricates on the first day of the occurrence's quarter.

const seed = createRequire(import.meta.url)('../../src/data/schedule.json') as {
  events: Array<{ id: string } & Record<string, unknown>>;
};

const EVENT = {
  ...seed.events.find(e => e.id === 'w1-sat-weights')!,
  warmup: [],
  cooldown: [],
  exercises: [
    { id: 'qp-1', name: 'Bench Press', category: 'strength', sets: 3, reps: '5', weight: '185 lb' },
    { id: 'qp-2', name: 'Plank', category: 'strength', sets: 2, duration: '60s' },
    { id: 'qp-3', name: 'Hip Flow', category: 'mobility', sets: 1, duration: '90s' },
  ],
};

function historyFor(eventDate: string): SetLogRow[] {
  const inQuarter = quarterStartOf(eventDate);
  expect(inQuarter < eventDate, 'the pinned mock day must not be a quarter\'s first').toBe(true);
  const row = (o: Partial<SetLogRow>): SetLogRow => ({
    event_id: 'qp-prev', event_date: inQuarter, section: 'exercise', exercise_id: 'qp-1', exercise_name: 'Bench Press',
    set_number: 1, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: null, actual_reps: null, actual_duration: null, is_autofilled: false, ...o,
  });
  return [
    row({ actual_weight: '205 lb', actual_reps: '3' }),
    row({ set_number: 2, actual_weight: '185 lb', actual_reps: '5' }),
    // Last quarter's heavier single is not this quarter's best.
    row({ event_date: '2000-01-03', actual_weight: '315 lb', actual_reps: '1' }),
    row({ exercise_id: 'qp-2', exercise_name: 'Plank', actual_duration: '90' }),
    row({ exercise_id: 'qp-3', exercise_name: 'Hip Flow', actual_duration: '120' }),
  ];
}

const json = (body: unknown) => ({
  status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body),
});

async function install(page: Page) {
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as { action: string; eventDate: string };
    if (body.action === 'save') return route.fulfill(json({ ok: true }));
    const response = sessionResponse(body, { event: EVENT }) as { event: WorkoutEvent; groups: TrackedSectionGroup[] };
    if (body.action === 'bootstrap') {
      const history = historyFor(body.eventDate);
      response.groups = attachQuarterBests(
        buildTrackerModel(response.event, [], [], buildLastPerformance(history)), history, body.eventDate);
    }
    return route.fulfill(json(response));
  });
}

async function openTracker(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Bench Press' })).toBeVisible({ timeout: 15000 });
}

const card = (page: Page, name: string) => page.locator('.tracker-exercise', { hasText: name });
const rows = (page: Page, name: string) => card(page, name).locator('.tracker-set:not(.tracker-set--head)');
const value = (page: Page, name: string) => rows(page, name).first().getByTestId('quarter-pr-value');

test('the quarter\'s best replaces the targets, on the first row, one field at a time', async ({ page }) => {
  await install(page);
  await openTracker(page);

  const bench = card(page, 'Bench Press');
  await expect(bench.locator('.tracker-set--head .tracker-set__planned')).toHaveText(/^Q[1-4] PR$/);
  await expect(value(page, 'Bench Press')).toHaveText('205 lb');
  // The rest of the rows carry no target, and the plan's label is gone.
  await expect(rows(page, 'Bench Press').nth(1).locator('.tracker-set__planned')).toHaveText('');
  await expect(rows(page, 'Bench Press').nth(2).locator('.tracker-set__planned')).toHaveText('');
  await expect(bench).not.toContainText('185 lb × 5');
  // A screen reader hears the whole set once.
  await expect(rows(page, 'Bench Press').first().locator('.quarter-pr__sr')).toHaveText(/Best set this quarter \(Q[1-4]\), logged .+: 205 lb × 3/);
  await shot(page, 'quarter-pr-weight');

  // Changes fade: only opacity moves, over half a second.
  await expect(value(page, 'Bench Press')).toHaveCSS('transition-property', 'opacity');
  await expect(value(page, 'Bench Press')).toHaveCSS('transition-duration', '0.5s');
  // The reps come in after the weight's turn, then it comes back round.
  await expect(value(page, 'Bench Press')).toHaveText('3 reps', { timeout: 7000 });
  await expect(value(page, 'Bench Press')).not.toHaveClass(/quarter-pr__value--hidden/);
  await shot(page, 'quarter-pr-reps');
  await expect(value(page, 'Bench Press')).toHaveText('205 lb', { timeout: 7000 });

  // A hold has one field: it stays put.
  await expect(value(page, 'Plank')).toHaveText('1:30');
  await expect(value(page, 'Plank')).not.toHaveClass(/quarter-pr__value--hidden/);

  // Mobility keeps its prescription.
  await expect(card(page, 'Hip Flow').locator('.tracker-set--head .tracker-set__planned')).toHaveText('target');
  await expect(rows(page, 'Hip Flow').first().locator('.tracker-set__planned')).toHaveText('90s');
});

test('with reduced motion asked for, the whole set shows on one line and nothing moves', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page);
  await openTracker(page);

  await expect(value(page, 'Bench Press')).toHaveText('205 lb × 3');
  await page.waitForTimeout(5000);
  await expect(value(page, 'Bench Press')).toHaveText('205 lb × 3');
  await expect(value(page, 'Bench Press')).not.toHaveClass(/quarter-pr__value--hidden/);
});
