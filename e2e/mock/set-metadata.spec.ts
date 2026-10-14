import { createRequire } from 'node:module';
import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { mockSession, sessionResponse } from '../lib/intercept.mjs';

// What a set was, not only what it weighed (phase55): the warm-up toggle in
// the row's leading slot saves through the autosave queue, comes back from
// the saved rows on reload and adds nothing to the summary's volume; the
// RPE field appears with the Profile preference on and snaps to half steps;
// the session note saves and shows in the summary; and a finished session's
// duration in the header opens the start/finish editor, whose refusals show
// the server's own reason (R4.1).

const seed = createRequire(import.meta.url)('../../src/data/schedule.json') as {
  events: Array<{ id: string } & Record<string, unknown>>;
};

// One lift, weight + reps, over the seed's Pull Day. The shared stub ghosts
// every row from a fabricated last performance (100 × 8, then 105 × 8).
const EVENT = {
  ...seed.events.find(e => e.id === 'w1-sat-weights')!,
  warmup: [],
  cooldown: [],
  exercises: [
    { id: 'sm-1', name: 'Bench Press', category: 'strength', sets: 3, reps: '5', weight: '185 lbs' },
  ],
};

interface SetRowWire {
  section: string; exercise_id: string; set_number: number;
  actual_weight: string | null; actual_reps: string | null;
  rpe?: number | null; is_warmup?: boolean;
}
interface SessionBody {
  action: string; eventId: string; eventDate: string;
  setLogs?: SetRowWire[]; sessionNote?: string; startedAt?: string; finishedAt?: string;
}
interface BootstrapWire {
  session: Record<string, unknown>;
  groups: Array<{ exercises: Array<{ sets: Array<Record<string, unknown>> }> }>;
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const setLogsOf = (req: Request): SetRowWire[] => (req.postDataJSON() as SessionBody)?.setLogs ?? [];
const isSave = (req: Request) =>
  req.url().includes('/api/workout-sessions') && (req.postDataJSON() as SessionBody)?.action === 'save';

/**
 * A workout-sessions stub with memory: saved set rows and the session note
 * are kept and replayed into the next bootstrap, so a reload shows what was
 * saved. Outranks the context-level stub for this page.
 */
class SessionStub {
  private rows = new Map<string, SetRowWire>();
  private note: string | null = null;
  private session: Record<string, unknown>;
  /** When set, edit-times answers 409 with this text. */
  refuseEdits: string | null = null;

  constructor(finished = false) {
    this.session = mockSession(finished ? {
      started_at: '2026-09-07T08:00:00.000Z', finished_at: '2026-09-07T09:00:00.000Z', total_duration_seconds: 3600,
    } : {});
  }

  async install(page: Page) {
    await page.route('**/api/workout-sessions*', route => {
      const body = route.request().postDataJSON() as SessionBody;
      if (body.action === 'save') {
        for (const r of body.setLogs ?? []) this.rows.set(`${r.section}|${r.exercise_id}|${r.set_number}`, r);
        if (typeof body.sessionNote === 'string') this.note = body.sessionNote;
        return route.fulfill(json({ ok: true }));
      }
      if (body.action === 'edit-times') {
        if (this.refuseEdits) return route.fulfill({ status: 409, contentType: 'text/plain', body: this.refuseEdits });
        const totalDurationSeconds = Math.round((Date.parse(body.finishedAt!) - Date.parse(body.startedAt!)) / 1000);
        Object.assign(this.session, { started_at: body.startedAt, finished_at: body.finishedAt, total_duration_seconds: totalDurationSeconds });
        return route.fulfill(json({ ok: true, startedAt: body.startedAt, finishedAt: body.finishedAt, totalDurationSeconds }));
      }
      const response = sessionResponse(body, { event: EVENT, session: { ...this.session, note: this.note } }) as BootstrapWire;
      if (body.action === 'bootstrap') {
        for (const group of response.groups) for (const tracked of group.exercises) for (const set of tracked.sets) {
          const row = this.rows.get(`exercise|sm-1|${set.setNumber}`);
          if (!row) continue;
          Object.assign(set, {
            actualWeight: row.actual_weight ?? '', actualReps: row.actual_reps ?? '',
            rpe: row.rpe != null ? String(row.rpe) : '', isWarmup: row.is_warmup === true,
            isLogged: true, shadow: null,
          });
        }
      }
      return route.fulfill(json(response));
    });
  }
}

async function openTracker(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Bench Press' })).toBeVisible({ timeout: 15000 });
}

// A reload is a second boot of the whole app, and a boot under a loaded
// machine (agent:check beside other sessions) has taken 13s; two of them
// left a 30s test no room for its last debounced save. openTracker's goto
// is the reload: a fresh document, nothing carried over but what was saved.
const TWO_BOOTS_MS = 90_000;

const row = (page: Page, n: number) => page.locator('.tracker-set:not(.tracker-set--head)').nth(n - 1);
const warmupToggle = (page: Page, n: number) => row(page, n).locator('.tracker-set__warmup');

test('a warm-up set saves, survives a reload, and adds nothing to the summary volume; the session note saves', async ({ page }) => {
  test.setTimeout(TWO_BOOTS_MS);
  await new SessionStub().install(page);
  await openTracker(page);
  // Off by default: no RPE column until the Profile preference is on.
  await expect(page.locator('.tracker-input--rpe')).toHaveCount(0);

  // Set 1: the tap commits last time's 100 × 8, then it is marked a warm-up.
  const weight1 = row(page, 1).locator('input.tracker-input--weight');
  await weight1.click();
  await expect(weight1).toHaveValue('100');
  const savedWarmup = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.set_number === 1 && r.is_warmup === true));
  await expect(warmupToggle(page, 1)).toHaveText('1');
  await row(page, 1).getByRole('button', { name: 'Set 1 — tap to mark as a warm-up' }).click();
  await expect(warmupToggle(page, 1)).toHaveAttribute('aria-pressed', 'true');
  await expect(warmupToggle(page, 1)).toHaveText('W');
  expect(setLogsOf(await savedWarmup).find(r => r.set_number === 1))
    .toMatchObject({ actual_weight: '100', actual_reps: '8', is_warmup: true, rpe: null });
  await shot(page, 'set-metadata-warmup');

  // Reload: the flag comes back with the saved row.
  await openTracker(page);
  await expect(warmupToggle(page, 1)).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 1).locator('input.tracker-input--weight')).toHaveValue('100');

  // Set 2 is a working set: 105 × 8. Set 3 stays untouched.
  const weight2 = row(page, 2).locator('input.tracker-input--weight');
  await weight2.click();
  await expect(weight2).toHaveValue('105');

  // The note on the whole session goes through the same queue.
  const savedNote = page.waitForRequest(req =>
    isSave(req) && (req.postDataJSON() as SessionBody).sessionNote === 'Slept four hours');
  await page.getByLabel('Session notes').fill('Slept four hours');
  // The ghost tap's deferred select() must not pull focus back to set 2.
  await expect(page.getByLabel('Session notes')).toHaveValue('Slept four hours');
  await expect(weight2).toHaveValue('105');
  await savedNote;

  // Finish (set 3 unlogged → confirm): the volume is the working set alone.
  await page.locator('.tracker-header__finish').click();
  await page.getByRole('button', { name: 'Finish anyway' }).click();
  const summary = page.locator('.tracker-summary');
  await expect(summary).toBeVisible();
  await expect(summary.getByTestId('summary-tonnage')).toHaveText('Volume 840');
  await expect(summary.locator('.tracker-summary__set').nth(0)).toContainText('warm-up');
  await expect(summary.locator('.tracker-summary__set').nth(1)).not.toContainText('warm-up');
  await expect(summary.getByTestId('summary-session-note')).toHaveText('Slept four hours');
  await shot(page, 'set-metadata-summary');

  // Counted again the moment it is a working set.
  await summary.getByRole('button', { name: 'Close summary' }).click();
  await row(page, 1).getByRole('button', { name: 'Set 1 is a warm-up — tap to count it' }).click();
  await expect(warmupToggle(page, 1)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.tracker-header__done-badge').click();
  await expect(page.locator('.tracker-summary').getByTestId('summary-tonnage')).toHaveText('Volume 1,640');
});

test('with the preference on, every row offers an RPE that snaps to half steps and saves', async ({ page }) => {
  test.setTimeout(TWO_BOOTS_MS);
  await page.addInitScript(() => { try { localStorage.setItem('apex.tracker.rpe', '1'); } catch { /* private mode */ } });
  await new SessionStub().install(page);
  await openTracker(page);
  await expect(page.locator('.tracker-set--head .tracker-input--rpe').first()).toHaveText('rpe');

  const rpe = row(page, 1).getByLabel('Set 1 RPE');
  const saved = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.set_number === 1 && r.rpe === 7.5));
  await rpe.click();
  await rpe.fill('7.3');
  await rpe.press('Enter');
  await expect(rpe).toHaveValue('7.5');
  expect(setLogsOf(await saved).find(r => r.set_number === 1)).toMatchObject({ rpe: 7.5, is_warmup: false });
  await shot(page, 'set-metadata-rpe');

  // Out of the scale settles to nothing — the row saves a null, never a 500.
  const cleared = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.set_number === 1 && r.rpe === null));
  await rpe.click();
  await rpe.fill('11');
  await rpe.press('Enter');
  await expect(rpe).toHaveValue('');
  await cleared;

  // Reload: the saved RPE rides the row.
  await rpe.click();
  await rpe.fill('9');
  await rpe.press('Enter');
  await page.waitForRequest(req => isSave(req) && setLogsOf(req).some(r => r.set_number === 1 && r.rpe === 9));
  await openTracker(page);
  await expect(row(page, 1).getByLabel('Set 1 RPE')).toHaveValue('9');
});

test('a finished session’s duration opens the start/finish editor; a refused edit shows the server’s reason', async ({ page, consoleErrors }) => {
  const stub = new SessionStub(true);
  await stub.install(page);
  await openTracker(page);

  const timer = page.getByRole('button', { name: /edit start and finish times/ });
  await expect(timer).toHaveText('1:00:00');
  await timer.click();
  const form = page.getByTestId('edit-times');
  await form.getByLabel('Started at').fill('2026-09-07T06:30');
  await form.getByLabel('Finished at').fill('2026-09-07T09:15');
  await expect(form.locator('.tracker-times__preview')).toHaveText('2:45:00');
  await shot(page, 'set-metadata-edit-times');

  const edited = page.waitForRequest(req =>
    req.url().includes('/api/workout-sessions') && (req.postDataJSON() as SessionBody)?.action === 'edit-times');
  await form.getByRole('button', { name: 'Save times' }).click();
  const body = (await edited).postDataJSON() as SessionBody;
  expect(Date.parse(body.finishedAt!) - Date.parse(body.startedAt!)).toBe(2.75 * 3600 * 1000);
  await expect(form).toHaveCount(0);
  await expect(timer).toHaveText('2:45:00');
  await expect(page.getByText('Workout times updated')).toBeVisible();

  // The reason is the server's, verbatim; the header keeps its duration.
  stub.refuseEdits = 'This workout was marked complete, not tracked — its duration is the plan’s estimate';
  await timer.click();
  await page.getByTestId('edit-times').getByLabel('Finished at').fill('2026-09-07T10:00');
  await page.getByTestId('edit-times').getByRole('button', { name: 'Save times' }).click();
  await expect(page.getByText(stub.refuseEdits)).toBeVisible();
  await expect(page.getByTestId('edit-times')).toBeVisible();
  await expect(timer).toHaveText('2:45:00');
  // Chromium logs the scripted 409 as a resource error; exactly one, and it
  // is the refusal under test (the pattern copy-week.spec.ts uses for its 500).
  await expect.poll(() => consoleErrors.filter(e => e.includes('status of 409')).length).toBe(1);
  consoleErrors.splice(consoleErrors.findIndex(e => e.includes('status of 409')), 1);
});
