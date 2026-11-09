import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS helper shared with the intercept
import { mockSession, sessionResponse } from '../lib/intercept.mjs';
import { rowToEvent } from '../../src/lib/schedule/mapping';

// docs/specs/tracker-runaway-finish, R5–R9: Finish on a session far past its
// plan asks when it really ended. The session clock is real time (write
// timestamps are never faked), so each test starts its session hours ago.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** One event on the frozen "today", in the workout_events row shape. */
function eventRow(overrides: Record<string, unknown>) {
  return {
    id: 'evt-stretch', type: 'stretching', title: 'Nightly Stretch', date: '2026-09-07',
    start_time: null, end_time: null, estimated_duration: 29, description: '',
    warmup: [], exercises: [], cooldown: [], difficulty: 2, location: null, cover_image_url: null,
    cardio_targets: null, climbing_targets: null, tags: [], equipment: [], is_recurring: false,
    recurrence_rule: null, recurring_frequency: null, recurring_days: null, recurring_end_date: null,
    source: null, template_id: null, scoring_type: null, time_cap_minutes: null,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

const ONE_SET = [{ id: 'squat', name: 'Goblet Squat', category: 'strength', sets: 1, reps: '8' }];

interface Scenario {
  row: Record<string, unknown>;
  startedAt: number;
  lastLoggedAt: number | null;
  /** The first `finish` answers 500 (no signal, a bad deploy). */
  failFirstFinish?: boolean;
}

/** Stub the event and the session API; returns every finish body sent. */
async function stage(page: Page, { row, startedAt, lastLoggedAt, failFirstFinish = false }: Scenario) {
  const finishes: Array<Record<string, unknown>> = [];
  let failNext = failFirstFinish;
  await page.route(/rest\/v1\/workout_events/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([row]) }));
  await page.route(/rest\/v1\/workout_sessions/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === 'finish') {
      finishes.push(body);
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 500, contentType: 'text/plain', body: 'Failed to finish session' });
      }
      const end = typeof body.finishedAt === 'string' ? Date.parse(body.finishedAt) : Date.now();
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, totalDurationSeconds: Math.round((end - startedAt) / 1000), prs: [], scoreRecord: null, recap: '' }),
      });
    }
    const answer = sessionResponse(body, {
      session: mockSession({ started_at: new Date(startedAt).toISOString() }),
      event: rowToEvent(row as never),
    });
    if (body.action === 'bootstrap') {
      // PostgREST's shape: an offset, not Z.
      answer.lastLoggedAt = lastLoggedAt === null ? null : new Date(lastLoggedAt).toISOString().replace('Z', '+00:00');
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
  });
  await gotoCalendar(page);
  await page.locator('.event-chip__main', { hasText: String(row.title) }).first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-header__finish')).toBeEnabled();
  return finishes;
}

/** The browser's own datetime-local text for an instant (its zone, to the minute). */
const inputValue = (page: Page, ms: number) => page.evaluate(t => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}, ms);

const prompt = (page: Page) => page.getByTestId('finish-time');

test('a runaway finish asks when it ended, defaulting to the last logged set', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  const lastLoggedAt = startedAt + 25 * MIN + 30_000;
  const finishes = await stage(page, { row: eventRow({}), startedAt, lastLoggedAt });

  await page.locator('.tracker-header__finish').click();

  // Nothing is recorded until the athlete answers.
  await expect(prompt(page)).toBeVisible();
  expect(finishes).toHaveLength(0);
  await expect(prompt(page)).toContainText('This session has run 5 h');
  await expect(prompt(page)).toContainText('against a 29 min plan');
  await expect(prompt(page)).toContainText('Prefilled with when your last set was saved.');
  const field = page.getByLabel('Ended at');
  await expect(field).toHaveValue(await inputValue(page, lastLoggedAt));
  await shot(page, 'tracker-runaway-prompt');
  // The rest runs at phone width: the bar wraps, every action still reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'tracker-runaway-prompt-mobile');

  // An empty field, a time before the start and a time after now cannot be the end.
  for (const value of ['', await inputValue(page, startedAt - 10 * MIN), await inputValue(page, Date.now() + 10 * MIN)]) {
    await field.fill(value);
    await expect(prompt(page).locator('.tracker-confirm__go'), `field "${value}"`).toBeDisabled();
    await expect(prompt(page)).toContainText('Pick a time between the start and now.');
  }

  // A chosen time goes as chosen.
  const chosen = startedAt + 40 * MIN;
  await field.fill(await inputValue(page, chosen));
  const go = prompt(page).locator('.tracker-confirm__go');
  await expect(go).toBeEnabled();
  await expect(go).toContainText('Finish at');
  await go.click();

  await expect(page.locator('.tracker-summary')).toBeVisible();
  expect(finishes).toHaveLength(1);
  const sent = Date.parse(finishes[0].finishedAt as string);
  // The field speaks minutes: the instant is the chosen minute's start.
  expect(sent).toBe(Math.floor(chosen / MIN) * MIN);
  const total = Math.round((sent - startedAt) / 1000);
  const mmss = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  await expect(page.locator('.tracker-header__timer--done')).toHaveText(mmss);
});

test('accepting the default sends the last logged instant to the millisecond', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  // Sub-second, so a minute-truncated field would show; .4 so the total rounds to 25:30.
  const lastLoggedAt = startedAt + 25 * MIN + 30_400;
  const finishes = await stage(page, { row: eventRow({}), startedAt, lastLoggedAt });

  await page.locator('.tracker-header__finish').click();
  await prompt(page).locator('.tracker-confirm__go').click();

  await expect(page.locator('.tracker-summary')).toBeVisible();
  expect(finishes.map(f => f.finishedAt)).toEqual([new Date(lastLoggedAt).toISOString()]);
  await expect(page.locator('.tracker-header__timer--done')).toHaveText('25:30');
  // The summary rounds to the minute: 25:30 reads 26 min, not five hours.
  await expect(page.locator('.tracker-summary__meta').first()).toContainText('· 26 min');
});

test('with nothing logged the default is the start plus the plan', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  await stage(page, { row: eventRow({}), startedAt, lastLoggedAt: null });

  await page.locator('.tracker-header__finish').click();

  await expect(prompt(page)).toContainText('Nothing logged yet — prefilled with the start plus the plan.');
  await expect(page.getByLabel('Ended at')).toHaveValue(await inputValue(page, startedAt + 29 * MIN));
});

test('It ran … finishes as before; Keep going records nothing', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  const finishes = await stage(page, { row: eventRow({}), startedAt, lastLoggedAt: startedAt + 20 * MIN });

  await page.locator('.tracker-header__finish').click();
  await prompt(page).getByRole('button', { name: 'Keep going' }).click();
  await expect(prompt(page)).toBeHidden();
  await expect(page.locator('.tracker-header__finish')).toBeVisible();
  expect(finishes).toHaveLength(0);

  await page.locator('.tracker-header__finish').click();
  await prompt(page).getByRole('button', { name: /^It ran 5 h/ }).click();

  await expect(page.locator('.tracker-summary')).toBeVisible();
  expect(finishes).toHaveLength(1);
  expect(finishes[0]).not.toHaveProperty('finishedAt');
});

test('a session under the threshold finishes with no prompt and no finishedAt', async ({ page }) => {
  // 50 minutes on a 29-minute plan: long, and normal.
  const startedAt = Date.now() - 50 * MIN;
  const finishes = await stage(page, { row: eventRow({}), startedAt, lastLoggedAt: startedAt + 20 * MIN });

  await page.locator('.tracker-header__finish').click();

  await expect(page.locator('.tracker-summary')).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);
  expect(finishes).toHaveLength(1);
  expect(finishes[0]).not.toHaveProperty('finishedAt');
});

test('the unlogged-sets confirm comes first, then the prompt', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  const finishes = await stage(page, { row: eventRow({ exercises: ONE_SET }), startedAt, lastLoggedAt: null });

  await page.locator('.tracker-header__finish').click();
  await expect(page.locator('.tracker-confirm__msg')).toContainText('1 planned set unlogged');
  await expect(prompt(page)).toHaveCount(0);

  await page.locator('.tracker-confirm__go', { hasText: 'Finish anyway' }).click();
  await expect(prompt(page)).toBeVisible();
  expect(finishes).toHaveLength(0);

  await prompt(page).locator('.tracker-confirm__go').click();
  await expect(page.locator('.tracker-summary')).toBeVisible();
  expect(finishes).toHaveLength(1);
  // The zero-fill the confirm promised still rides the finish.
  expect(finishes[0].autofillRows).toHaveLength(1);
  expect(finishes[0].finishedAt).toBe(new Date(startedAt + 29 * MIN).toISOString());
});

test('a set logged this sitting moves the default to now', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  await stage(page, { row: eventRow({ exercises: ONE_SET }), startedAt, lastLoggedAt: startedAt + 20 * MIN });

  const before = Date.now();
  await page.getByLabel('Set 1 reps').fill('8');
  const after = Date.now();
  await page.locator('.tracker-header__finish').click();

  await expect(prompt(page)).toContainText('Prefilled with when your last set was saved.');
  const value = await page.getByLabel('Ended at').inputValue();
  // The minute the set was typed in, not the bootstrap's 20 minutes in.
  expect([await inputValue(page, before), await inputValue(page, after)]).toContain(value);
  expect(value).not.toBe(await inputValue(page, startedAt + 20 * MIN));
});

test('a For Time score after a corrected finish prefills the corrected length', async ({ page }) => {
  const startedAt = Date.now() - 3 * HOUR;
  const lastLoggedAt = startedAt + 24 * MIN + 30_000;
  const row = eventRow({
    id: 'evt-fran', type: 'weights', title: 'FRAN', estimated_duration: 20,
    template_id: 'wt-fran', scoring_type: 'for-time',
  });
  const finishes = await stage(page, { row, startedAt, lastLoggedAt });

  await page.locator('.tracker-header__finish').click();
  await prompt(page).locator('.tracker-confirm__go').click();

  // The score step, prefilled from the corrected end, not three hours.
  await expect(page.locator('.tracker-score__input')).toHaveValue('24:30');
  expect(finishes).toHaveLength(0);
  await page.locator('.tracker-confirm__go', { hasText: 'Save score' }).click();

  await expect(page.locator('.tracker-summary')).toBeVisible();
  expect(finishes).toHaveLength(1);
  expect(finishes[0].finishedAt).toBe(new Date(lastLoggedAt).toISOString());
  expect(finishes[0].score).toEqual({ templateId: 'wt-fran', type: 'for-time', timeSeconds: 1470 });
});

test('Finish tapped again while the prompt is up offers the set just logged', async ({ page }) => {
  const startedAt = Date.now() - 5 * HOUR;
  await stage(page, { row: eventRow({ exercises: ONE_SET }), startedAt, lastLoggedAt: startedAt + 20 * MIN });

  await page.locator('.tracker-header__finish').click();
  await page.locator('.tracker-confirm__go', { hasText: 'Finish anyway' }).click();
  const field = page.getByLabel('Ended at');
  await expect(field).toHaveValue(await inputValue(page, startedAt + 20 * MIN));

  // A set logged below the bar, then the header's Finish again.
  const before = Date.now();
  await page.getByLabel('Set 1 reps').fill('8');
  const after = Date.now();
  await page.locator('.tracker-header__finish').click();

  // The field and the action agree on the new default.
  await expect(field).not.toHaveValue(await inputValue(page, startedAt + 20 * MIN));
  expect([await inputValue(page, before), await inputValue(page, after)]).toContain(await field.inputValue());
  await expect(prompt(page).locator('.tracker-confirm__go')).toBeEnabled();
});

test('a finish that fails keeps the chosen end for the next Finish', async ({ page, consoleErrors }) => {
  const startedAt = Date.now() - 5 * HOUR;
  const finishes = await stage(page, {
    row: eventRow({}), startedAt, lastLoggedAt: startedAt + 20 * MIN, failFirstFinish: true,
  });

  await page.locator('.tracker-header__finish').click();
  const chosen = startedAt + 33 * MIN;
  await page.getByLabel('Ended at').fill(await inputValue(page, chosen));
  await prompt(page).locator('.tracker-confirm__go').click();

  // The send failed: nothing finished, the prompt closed.
  await expect.poll(() => finishes.length).toBe(1);
  await expect(page.locator('.tracker-header__finish')).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);

  // The next Finish goes out with the answer already given, without asking again.
  await page.locator('.tracker-header__finish').click();
  await expect(page.locator('.tracker-summary')).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);
  expect(finishes).toHaveLength(2);
  expect(finishes[1].finishedAt).toBe(new Date(Math.floor(chosen / MIN) * MIN).toISOString());

  // The stubbed 500 is the only console error, by design.
  expect(consoleErrors.every(e => /status of 500/.test(e)), consoleErrors.join('\n')).toBe(true);
  consoleErrors.length = 0;
});
