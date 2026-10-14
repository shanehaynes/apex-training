import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
import { stubLibrary, LIBRARY } from '../lib/library';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { buildTrackerModel, type TrackedSectionGroup } from '../../src/lib/tracking/plan';
import { computeSessionPRs, describeRecord } from '../../src/lib/tracking/records';
import type { SetLogRow } from '../../src/lib/db/types';
import type { ExerciseCategory, WorkoutEvent } from '../../src/types/workout';

// Climbing is logged like climbing: a pitch row takes a grade, an ascent
// style and an attempt count, and saves them through the autosave queue —
// the grade exactly as typed, never suffixed as a weight, even under a kg
// profile. A clean send harder than any before is a send record in the
// summary (the finish stub runs the server's own computeSessionPRs over the
// saved rows), and a pitch can be added mid-session from the library.
//
// The mock clock is Mon 2026-09-07; workout_events is stubbed so that day
// holds one outdoor climb with two planned pitches.

const DATE = '2026-09-07';

const EVENT = {
  id: 'crag-day', type: 'outdoor-climbing', title: 'Crag Day', date: DATE, startTime: '8:00 AM', endTime: '4:00 PM',
  estimatedDuration: 480, description: '', difficulty: 3, tags: [], equipment: [], isCompleted: false, isRecurring: false,
  warmup: [], cooldown: [],
  exercises: [
    { id: 'p1', name: 'Sport', category: 'climbing', climbStyle: 'sport', grade: '5.10a', ascentStyle: 'redpoint' },
    { id: 'p2', name: 'Trad', category: 'climbing', climbStyle: 'trad', grade: '5.9' },
  ],
};

const EVENT_ROW = {
  id: EVENT.id, type: EVENT.type, title: EVENT.title, subtitle: null, date: DATE, start_time: '8:00 AM', end_time: '4:00 PM',
  estimated_duration: 480, description: '', warmup: [], exercises: EVENT.exercises, cooldown: [], difficulty: 3,
  location: null, cover_image_url: null, tags: [], equipment: [], sport: 'climbing', template_id: null,
  climbing_targets: null, cardio_targets: null,
  is_recurring: false, recurrence_rule: null, recurring_frequency: null, recurring_days: null, recurring_end_date: null,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

// Prior sends the finish stub compares against: Sport went at 5.9, Trad at 5.8.
const HISTORY: SetLogRow[] = [
  ['Sport', '5.9', 'redpoint'],
  ['Trad', '5.8', 'flash'],
].map(([name, grade, style], i) => ({
  event_id: 'crag-prev', event_date: '2026-08-30', section: 'exercise', exercise_id: `prev-${i}`, exercise_name: name,
  set_number: 1, planned_weight: null, planned_reps: null, planned_duration: null,
  actual_weight: grade, actual_reps: null, actual_duration: null,
  is_autofilled: false, is_warmup: false, ascent_style: style as SetLogRow['ascent_style'], attempts: null,
}));

const LEAD = {
  ...LIBRARY[0], id: 'lead', canonical_name: 'Lead', category: 'climbing',
};
const CATEGORIES = new Map<string, ExerciseCategory>([['lead', 'climbing']]);

interface SessionBody { action: string; eventId: string; eventDate: string; setLogs?: SetLogRow[] }

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const setLogsOf = (req: Request): SetLogRow[] => (req.postDataJSON() as SessionBody)?.setLogs ?? [];
const isSave = (req: Request) =>
  req.url().includes('/api/workout-sessions') && (req.postDataJSON() as SessionBody)?.action === 'save';
const savedWith = (match: (row: SetLogRow) => boolean) => (req: Request) => isSave(req) && setLogsOf(req).some(match);

/**
 * A workout-sessions stub with memory: saved rows replay into the next
 * bootstrap through the server's own model builder, and finish answers with
 * the server's own PR computation over them.
 */
class SessionStub {
  private rows = new Map<string, SetLogRow>();

  private model(body: SessionBody): { event: WorkoutEvent; groups: TrackedSectionGroup[] } {
    const { event } = sessionResponse({ ...body, action: 'bootstrap' }, { event: EVENT }) as { event: WorkoutEvent };
    const groups = buildTrackerModel(event, [...this.rows.values()], [], new Map(), new Map(), [], CATEGORIES);
    return { event, groups };
  }

  async install(page: Page) {
    await page.route('**/api/workout-sessions*', route => {
      const body = route.request().postDataJSON() as SessionBody;
      if (body.action === 'save') {
        for (const r of body.setLogs ?? []) this.rows.set(`${r.section}|${r.exercise_id}|${r.set_number}`, r);
        return route.fulfill(json({ ok: true }));
      }
      if (body.action === 'bootstrap') {
        const base = sessionResponse(body, { event: EVENT }) as Record<string, unknown>;
        return route.fulfill(json({ ...base, groups: this.model(body).groups }));
      }
      if (body.action === 'finish') {
        const prs = computeSessionPRs(this.model(body).groups, HISTORY).map(pr => ({ ...pr, description: describeRecord(pr) }));
        return route.fulfill(json({ ok: true, totalDurationSeconds: 3600, prs, scoreRecord: null, recap: '' }));
      }
      return route.fulfill(json(sessionResponse(body, { event: EVENT })));
    });
  }
}

/** A kg profile: a bare number typed into a weight field would be saved as "N kg". */
async function stubKgProfile(page: Page) {
  const profile = { ...driverProfile(), weight_unit: 'kg', body_weight_lb: 160 };
  await page.route('**/rest/v1/profiles*', route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill(json(wantsObject ? profile : [profile]));
  });
}

async function openCragDay(page: Page) {
  await page.route(/rest\/v1\/workout_events/, route => route.fulfill(json([EVENT_ROW])));
  await gotoCalendar(page);
  await page.locator('.event-chip__main', { hasText: 'Crag Day' }).click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Sport' })).toBeVisible({ timeout: 15000 });
}

const pitch = (page: Page, name: string) => page.locator('.tracker-exercise', { has: page.locator('.tracker-exercise__name', { hasText: name }) });

test('a pitch logs its style and attempts, its grade unchanged; a harder clean send is a send record in the summary', async ({ page }) => {
  await stubKgProfile(page);
  await new SessionStub().install(page);
  await openCragDay(page);

  const sport = pitch(page, 'Sport');
  await expect(sport.locator('.tracker-set--head')).toContainText('grade');
  await expect(sport.locator('.tracker-set--head')).toContainText('style');
  await expect(sport.locator('.tracker-set--head')).toContainText('tries');
  // A pitch has no reps or time to ask for, and no swap: it stays a pitch.
  await expect(sport.locator('input.tracker-input--reps')).toHaveCount(0);
  await expect(sport.getByRole('button', { name: /^Swap / })).toHaveCount(0);

  // Saying how the planned pitch went logs its planned grade with the style.
  const styled = page.waitForRequest(savedWith(r => r.exercise_id === 'p1' && r.ascent_style === 'redpoint'));
  await sport.getByLabel('Set 1 ascent style').selectOption('redpoint');
  await expect(sport.getByLabel('Set 1 grade')).toHaveValue('5.10a');
  expect(setLogsOf(await styled).find(r => r.exercise_id === 'p1')).toMatchObject({ actual_weight: '5.10a', ascent_style: 'redpoint' });

  // Two goes: the stepper counts up, and the count rides the same row.
  await expect(sport.getByLabel('Set 1 attempts')).toHaveText('–');
  const tried = page.waitForRequest(savedWith(r => r.exercise_id === 'p1' && r.attempts === 2));
  await sport.getByRole('button', { name: 'One more attempt on set 1' }).click();
  await sport.getByRole('button', { name: 'One more attempt on set 1' }).click();
  await expect(sport.getByLabel('Set 1 attempts')).toHaveText('2');
  expect(setLogsOf(await tried).find(r => r.exercise_id === 'p1')).toMatchObject({ actual_weight: '5.10a', ascent_style: 'redpoint', attempts: 2 });

  // A grade typed by hand is saved exactly as typed: "5.9" reads as a bare
  // number, and under a kg profile a weight field would make it "5.9 kg".
  const trad = pitch(page, 'Trad');
  const grade = trad.getByLabel('Set 1 grade');
  const typed = page.waitForRequest(savedWith(r => r.exercise_id === 'p2' && r.actual_weight === '5.9'));
  await grade.click();
  await grade.fill('5.9');
  await grade.press('Enter');
  await expect(grade).toHaveValue('5.9');
  await typed;
  // An attempt at it: logged, but not a send.
  const attempted = page.waitForRequest(savedWith(r => r.exercise_id === 'p2' && r.ascent_style === 'attempt'));
  await trad.getByLabel('Set 1 ascent style').selectOption('attempt');
  expect(setLogsOf(await attempted).find(r => r.exercise_id === 'p2')).toMatchObject({ actual_weight: '5.9', ascent_style: 'attempt' });
  await shot(page, 'climbing-pitch-rows');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sport.getByLabel('Set 1 ascent style')).toBeVisible();
  await shot(page, 'climbing-pitch-rows-mobile');
  await page.setViewportSize({ width: 1280, height: 950 });

  // Finish: the server's record for Sport, nothing for the attempted Trad.
  await page.locator('.tracker-header__finish').click();
  const summary = page.locator('.tracker-summary');
  await expect(summary).toBeVisible();
  const records = summary.locator('.tracker-summary__pr');
  await expect(records).toHaveCount(1);
  await expect(records.first()).toHaveText('Sport — Redpointed 5.10a, up from 5.9 on Aug 30');
  // The log reads as climbing, and a grade adds no volume.
  await expect(summary.locator('.tracker-summary__exercise', { hasText: 'Sport' })).toContainText('5.10a · Redpointed · 2 tries');
  await expect(summary.locator('.tracker-summary__exercise', { hasText: 'Trad' })).toContainText('5.9 · Attempted');
  await expect(summary.getByTestId('summary-tonnage')).toHaveCount(0);
  await shot(page, 'climbing-send-summary');
});

test('a pitch can be added mid-session from the library, and comes back a pitch after a reload', async ({ page }) => {
  await stubKgProfile(page);
  await stubLibrary(page, [...LIBRARY, LEAD]);
  await new SessionStub().install(page);
  await openCragDay(page);
  const before = await page.locator('.tracker-exercise').count();

  await page.getByRole('button', { name: 'Add exercise' }).click();
  const picker = page.locator('.exercise-picker');
  await expect(picker).toBeVisible();
  // A climbing session offers pitches, and opens on them.
  await expect(picker.locator('.library-filter--active', { hasText: /^climbing$/i })).toBeVisible();
  await picker.locator('.exercise-picker__row', { hasText: 'Lead' }).click();

  await expect(page.locator('.tracker-exercise')).toHaveCount(before + 1);
  const lead = pitch(page, 'Lead');
  await expect(lead).toContainText('Added to this workout — the plan is unchanged.');
  await expect(lead.getByLabel('Set 1 ascent style')).toBeVisible();

  // One pitch row, saved under its own id: the grade as typed, then the style.
  const grade = lead.getByLabel('Set 1 grade');
  const typed = page.waitForRequest(savedWith(r => r.exercise_id.startsWith('added-') && r.actual_weight === '5.10b'));
  await grade.click();
  await grade.fill('5.10b');
  await grade.press('Enter');
  expect(setLogsOf(await typed).find(r => r.exercise_id.startsWith('added-')))
    .toMatchObject({ exercise_name: 'Lead', definition_id: 'lead', set_number: 1, actual_weight: '5.10b', planned_weight: null });
  const flashed = page.waitForRequest(savedWith(r => r.exercise_id.startsWith('added-') && r.ascent_style === 'flash'));
  await lead.getByLabel('Set 1 ascent style').selectOption('flash');
  await flashed;
  await shot(page, 'climbing-added-pitch');

  // Reload: rebuilt from its rows, the added entry is still a pitch.
  await page.reload();
  await openCragDay(page);
  const back = pitch(page, 'Lead');
  await expect(back.getByLabel('Set 1 grade')).toHaveValue('5.10b');
  await expect(back.getByLabel('Set 1 ascent style')).toHaveValue('flash');
  await expect(back.locator('input.tracker-input--reps')).toHaveCount(0);
});
