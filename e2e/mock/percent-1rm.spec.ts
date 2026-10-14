import { createRequire } from 'node:module';
import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';
import { buildLastPerformance, buildTrackerModel, type TrackedSectionGroup } from '../../src/lib/tracking/plan';
import { resolvePercentTargets } from '../../src/lib/tracking/percent';
import { DEFAULT_WEIGHT_CONTEXT } from '../../src/lib/tracking/weight';
import type { SetLogRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

// A percentage target reads as today's load: the server resolves "80%" to
// 80% of the lift's best estimated 1RM and the tracker shows "185 (80%)",
// ghosts 185 in the weight field and commits 185 on the tap. A lift with no
// history keeps its raw "75%". The stub below builds the bootstrap with the
// same pure builders the server runs, over history this spec fabricates.

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

// Bench only: a 230 lb single (1RM 230 → 70% = 161 → 160, 80% = 184 → 185), then 200 × 3.
const HISTORY: SetLogRow[] = [1, 2].map(setNumber => ({
  event_id: 'pc-prev', event_date: '2000-01-01', section: 'exercise', exercise_id: 'pc-1', exercise_name: 'Bench Press',
  set_number: setNumber, planned_weight: null, planned_reps: null, planned_duration: null,
  actual_weight: setNumber === 1 ? '230' : '200', actual_reps: setNumber === 1 ? '1' : '3', actual_duration: null,
  is_autofilled: false,
}));

interface SetRowWire { exercise_id: string; set_number: number; planned_weight: string | null; actual_weight: string | null; actual_reps: string | null }
interface SessionBody { action: string; setLogs?: SetRowWire[] }

const json = (body: unknown) => ({
  status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body),
});
const setLogsOf = (req: Request): SetRowWire[] => (req.postDataJSON() as SessionBody)?.setLogs ?? [];
const isSave = (req: Request) =>
  req.url().includes('/api/workout-sessions') && (req.postDataJSON() as SessionBody)?.action === 'save';

async function installSessionStub(page: Page) {
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as SessionBody;
    if (body.action === 'save') return route.fulfill(json({ ok: true }));
    const response = sessionResponse(body, { event: EVENT }) as { event: WorkoutEvent; groups: TrackedSectionGroup[] };
    if (body.action === 'bootstrap') {
      const model = buildTrackerModel(response.event, [], [], buildLastPerformance(HISTORY));
      response.groups = resolvePercentTargets(model, HISTORY, DEFAULT_WEIGHT_CONTEXT);
    }
    return route.fulfill(json(response));
  });
}

const rowOf = (page: Page, exercise: string, n: number) =>
  page.locator('.tracker-exercise', { hasText: exercise }).locator('.tracker-set:not(.tracker-set--head)').nth(n - 1);

test('a percentage target shows the resolved load, ghosts it, and the tap commits it', async ({ page }) => {
  await installSessionStub(page);
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Bench Press' })).toBeVisible({ timeout: 15000 });

  const bench1 = rowOf(page, 'Bench Press', 1);
  const bench2 = rowOf(page, 'Bench Press', 2);
  await expect(bench1.locator('.tracker-set__planned')).toHaveText('160 (70%) × 5');
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
  const saved = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.exercise_id === 'pc-1' && r.set_number === 2 && r.actual_weight === '185'));
  const weight2 = bench2.locator('input.tracker-input--weight');
  await weight2.click();
  await expect(weight2).toHaveValue('185');
  await expect(bench2.locator('input.tracker-input--reps')).toHaveValue('3');
  const sent = setLogsOf(await saved).find(r => r.exercise_id === 'pc-1' && r.set_number === 2)!;
  expect(sent).toMatchObject({ planned_weight: '80%', actual_weight: '185', actual_reps: '3' });
  expect(sent).not.toHaveProperty('resolvedPlannedWeight');
});
