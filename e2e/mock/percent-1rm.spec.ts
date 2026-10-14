import { createRequire } from 'node:module';
import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { buildLastPerformance, buildTrackerModel, type TrackedSectionGroup } from '../../src/lib/tracking/plan';
import { resolvePercentTargets } from '../../src/lib/tracking/percent';
import type { WeightUnit } from '../../src/lib/tracking/weight';
import type { SetLogRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

// A percentage target reads as today's load: the server resolves "80%" to
// 80% of the lift's best estimated 1RM under the profile's unit and the
// tracker shows "185 (80%)", ghosts 185 in the weight field and commits
// "185 lb" on the tap. A lift with no history keeps its raw "75%"; a swap
// onto another lift drops the old lift's load. The stub below stands in for
// the server: it builds the bootstrap with the same pure builders, over
// history this spec fabricates, under the unit the stubbed profile holds.

const seed = createRequire(import.meta.url)('../../src/data/schedule.json') as {
  events: Array<{ id: string } & Record<string, unknown>>;
};

const EVENT = {
  ...seed.events.find(e => e.id === 'w1-sat-weights')!,
  warmup: [],
  cooldown: [],
  exercises: [
    {
      id: 'pc-1', name: 'Bench Press', category: 'strength',
      plannedSets: [{ setNumber: 1, targetWeight: '70%', targetReps: '5' }, { setNumber: 2, targetWeight: '80%', targetReps: '3' }],
    },
    { id: 'pc-2', name: 'Front Squat', category: 'strength', sets: 1, reps: '5', weight: '75%' },
  ],
};

/** Bench only: a single at `top`, then 200 × 3 (or `second` × 3). */
function benchHistory(top: string, second: string): SetLogRow[] {
  return [1, 2].map(setNumber => ({
    event_id: 'pc-prev', event_date: '2000-01-01', section: 'exercise', exercise_id: 'pc-1', exercise_name: 'Bench Press',
    set_number: setNumber, planned_weight: null, planned_reps: null, planned_duration: null,
    actual_weight: setNumber === 1 ? top : second, actual_reps: setNumber === 1 ? '1' : '3', actual_duration: null,
    is_autofilled: false,
  }));
}

interface SetRowWire { exercise_id: string; set_number: number; planned_weight: string | null; actual_weight: string | null; actual_reps: string | null }
interface SessionBody { action: string; setLogs?: SetRowWire[] }

const json = (body: unknown) => ({
  status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body),
});
const setLogsOf = (req: Request): SetRowWire[] => (req.postDataJSON() as SessionBody)?.setLogs ?? [];
const isSave = (req: Request) =>
  req.url().includes('/api/workout-sessions') && (req.postDataJSON() as SessionBody)?.action === 'save';

/**
 * The profile (with its unit) and the session API, resolving under that unit
 * as the server does. `clientUnit` is what the profile says by the time the
 * client reads it — a unit changed in Settings after the bootstrap.
 */
async function install(page: Page, unit: WeightUnit, history: SetLogRow[], clientUnit: WeightUnit = unit) {
  const profile = { ...driverProfile(), weight_unit: clientUnit, body_weight_lb: null };
  await page.route('**/rest/v1/profiles*', route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill(json(wantsObject ? profile : [profile]));
  });
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as SessionBody;
    if (body.action === 'save') return route.fulfill(json({ ok: true }));
    const response = sessionResponse(body, { event: EVENT }) as { event: WorkoutEvent; groups: TrackedSectionGroup[] };
    if (body.action === 'bootstrap') {
      const model = buildTrackerModel(response.event, [], [], buildLastPerformance(history));
      response.groups = resolvePercentTargets(model, history, { unit, bodyWeightLb: null });
    }
    return route.fulfill(json(response));
  });
}

/** One strength movement in the library, so the swap picker has somewhere to go. */
async function stubLibrary(page: Page) {
  await page.route('**/exercise_definitions*', route => route.fulfill(json([{
    id: 'def-incline', canonical_name: 'Incline Bench Press', aliases: [], category: 'strength',
    muscle_groups: ['chest'], equipment: [], image_url: null, technique_notes: null,
    is_unilateral: false, default_sets: 3, default_reps: '5', default_duration: null, default_weight: null,
    default_rest: null, archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }])));
}

async function openTracker(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Bench Press' })).toBeVisible({ timeout: 15000 });
}

const rowOf = (page: Page, exercise: string, n: number) =>
  page.locator('.tracker-exercise', { hasText: exercise }).locator('.tracker-set:not(.tracker-set--head)').nth(n - 1);

/** Tap set 2's weight ghost; resolves with the saved bench row for set 2 once its weight is `expected`. */
async function tapBenchSet2(page: Page, expected: string): Promise<SetRowWire> {
  const saved = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.exercise_id === 'pc-1' && r.set_number === 2 && r.actual_weight === expected));
  const weight2 = rowOf(page, 'Bench Press', 2).locator('input.tracker-input--weight');
  await weight2.click();
  await expect(weight2).toHaveValue(expected);
  return setLogsOf(await saved).find(r => r.exercise_id === 'pc-1' && r.set_number === 2)!;
}

test('a percentage target shows the resolved load, ghosts it, and the tap commits it with its unit', async ({ page }) => {
  // 1RM 230: 70% = 161 → 160, 80% = 184 → 185.
  await install(page, 'lb', benchHistory('230', '200'));
  await openTracker(page);

  const bench2 = rowOf(page, 'Bench Press', 2);
  await expect(rowOf(page, 'Bench Press', 1).locator('.tracker-set__planned')).toHaveText('160 (70%) × 5');
  await expect(bench2.locator('.tracker-set__planned')).toHaveText('185 (80%) × 3');
  await expect(bench2.locator('input.tracker-input--weight')).toHaveAttribute('placeholder', '185');
  // Reps still ghost last time's.
  await expect(bench2.locator('input.tracker-input--reps')).toHaveAttribute('placeholder', '3');

  // No history for the squat: the raw text, and nothing to hint.
  const squat = rowOf(page, 'Front Squat', 1);
  await expect(squat.locator('.tracker-set__planned')).toHaveText('75% × 5');
  await expect(squat.locator('input.tracker-input--weight')).not.toHaveAttribute('placeholder', /./);
  await shot(page, 'percent-1rm-resolved');

  // The tap commits today's load, not last time's 200; the plan's "80%" rides the row as written.
  const sent = await tapBenchSet2(page, '185 lb');
  await expect(bench2.locator('input.tracker-input--reps')).toHaveValue('3');
  expect(sent).toMatchObject({ planned_weight: '80%', actual_weight: '185 lb', actual_reps: '3' });
  expect(sent).not.toHaveProperty('resolvedPlannedWeight');
});

test('under a kg profile the load is kilograms on the label, the ghost and the saved row', async ({ page }) => {
  // 1RM 100 kg: 80% = 80 kg (a pounds reading would have said 177.5).
  await install(page, 'kg', benchHistory('100 kg', '90 kg'));
  await openTracker(page);

  const bench2 = rowOf(page, 'Bench Press', 2);
  await expect(bench2.locator('.tracker-set__planned')).toHaveText('80 (80%) × 3');
  await expect(bench2.locator('input.tracker-input--weight')).toHaveAttribute('placeholder', '80');
  const sent = await tapBenchSet2(page, '80 kg');
  expect(sent).toMatchObject({ planned_weight: '80%', actual_weight: '80 kg' });
});

test('a unit changed after the bootstrap does not change what the resolved load means', async ({ page }) => {
  // Resolved as 80 kg; the client now reads bare numbers as pounds. The tap stores "80 kg", never "80 lb".
  await install(page, 'kg', benchHistory('100 kg', '90 kg'), 'lb');
  await openTracker(page);
  await expect(rowOf(page, 'Bench Press', 2).locator('.tracker-set__planned')).toHaveText('80 (80%) × 3');
  const sent = await tapBenchSet2(page, '80 kg');
  expect(sent).toMatchObject({ planned_weight: '80%', actual_weight: '80 kg' });
});

test("a swap onto another lift drops the old lift's resolved load", async ({ page }) => {
  await install(page, 'lb', benchHistory('230', '200'));
  await stubLibrary(page);
  await openTracker(page);

  const bench = page.locator('.tracker-exercise', { hasText: 'Bench Press' }).first();
  await expect(rowOf(page, 'Bench Press', 2).locator('.tracker-set__planned')).toHaveText('185 (80%) × 3');
  await bench.locator('.tracker-exercise__swap').first().click();
  await page.locator('.exercise-picker__row', { hasText: 'Incline Bench Press' }).click();
  await expect(page.locator('.exercise-picker')).toHaveCount(0);

  const swapped = rowOf(page, 'Incline Bench Press', 2);
  await expect(swapped.locator('.tracker-set__planned')).toHaveText('80% × 3');
  await expect(swapped.locator('input.tracker-input--weight')).not.toHaveAttribute('placeholder', '185');
  const saved = page.waitForRequest(req => isSave(req) && setLogsOf(req).some(r => r.exercise_id === 'pc-1' && r.set_number === 2));
  await swapped.locator('input.tracker-input--weight').click();
  const sent = setLogsOf(await saved).find(r => r.exercise_id === 'pc-1' && r.set_number === 2)!;
  expect(sent.actual_weight, 'the bench load is not the incline load').not.toBe('185 lb');
  expect(sent.actual_weight).not.toBe('185');
});

test('at phone width the load, the percentage and the reps all show, none cut off', async ({ page }) => {
  // The 80 px planned column used to cut "185 (80%) × 3" off with an ellipsis.
  await install(page, 'lb', benchHistory('230', '200'));
  await openTracker(page);
  await page.setViewportSize({ width: 375, height: 812 });

  for (const [n, text] of [[1, '160 (70%) × 5'], [2, '185 (80%) × 3']] as const) {
    const label = rowOf(page, 'Bench Press', n).locator('.tracker-set__planned');
    await expect(label).toHaveText(text);
    await expect(label).toBeVisible();
    const clipped = await label.evaluate(el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    expect(clipped, `"${text}" is not truncated`).toBe(false);
    // Nothing of it hides under the inputs beside it.
    const [labelBox, inputBox] = await Promise.all([
      label.boundingBox(),
      rowOf(page, 'Bench Press', n).locator('.tracker-set__inputs').boundingBox(),
    ]);
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(inputBox!.x);
  }
  await shot(page, 'percent-1rm-phone');
});
