import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';

// The rest countdown between sets (rulings R2.1–R2.5): a row's reps or
// duration going empty → non-empty starts it from the exercise's rest text,
// a tapped ghost row counts, +15 s and Skip, a same-row edit never restarts,
// and the remaining time is derived from an absolute end so a tab that slept
// reads right when it is back. The page clock is Playwright's, paused once
// the tracker is up, so every reading here is exact.

const seed = createRequire(import.meta.url)('../../src/data/schedule.json') as {
  events: Array<{ id: string } & Record<string, unknown>>;
};

// One lift with every rest grammar the tracker meets, over the seed's Pull
// Day. The shared stub ghosts every row from a fabricated last performance.
const REST_EVENT = {
  ...seed.events.find(e => e.id === 'w1-sat-weights')!,
  warmup: [],
  cooldown: [],
  exercises: [
    { id: 'rt-1', name: 'Weighted Pull-Ups', category: 'strength', sets: 3, reps: '5', weight: 'BW + 35 lbs', restPeriod: '90s' },
    { id: 'rt-2', name: 'Barbell Row', category: 'strength', sets: 3, reps: '6', weight: '175 lbs', restPeriod: '2-3 min' },
    { id: 'rt-3', name: 'Plank', category: 'strength', sets: 3, duration: '30s', restPeriod: '60 sec' },
    { id: 'rt-4', name: 'Hammer Curl', category: 'strength', sets: 3, reps: '12', restPeriod: 'as needed' },
    { id: 'rt-5', name: 'Farmer Carry', category: 'strength', sets: 3, weight: '70 lbs', restPeriod: '90s' },
  ],
};

const START = new Date('2026-09-07T08:00:00');

interface BootstrapGroups { groups: Array<{ exercises: Array<{ exercise: { id: string }; sets: Array<Record<string, unknown>> }> }> }

async function openTracker(page: Page, edit?: (bootstrap: BootstrapGroups) => void) {
  await page.clock.install({ time: START });
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as { action: string };
    const response = sessionResponse(body, { event: REST_EVENT }) as BootstrapGroups;
    if (body.action === 'bootstrap') {
      // The stub ghosts every row from the last performance; set 3 of each
      // exercise is made clean so typing, not tapping, is what commits it.
      for (const group of response.groups) for (const t of group.exercises) t.sets[2].shadow = null;
      edit?.(response);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Farmer Carry' })).toBeVisible({ timeout: 15000 });
  // Frozen from here: only runFor / fastForward move the page's clock.
  await page.clock.pauseAt(new Date(START.getTime() + 60_000));
}

const bar = (page: Page) => page.getByTestId('rest-timer');
const time = (page: Page) => bar(page).locator('.rest-timer__time');
const card = (page: Page, name: string) =>
  page.locator('.tracker-exercise', { has: page.locator('.tracker-exercise__name', { hasText: name }) });
const row = (page: Page, name: string, n: number) =>
  card(page, name).locator('.tracker-set:not(.tracker-set--head)').nth(n - 1);

test('logging a set starts the rest its exercise prescribes; +15 and Skip; one row, one timer', async ({ page }) => {
  await openTracker(page);
  await expect(bar(page)).toHaveCount(0);

  // Set 3 (no ghost): reps typed, Enter commits — 90s reads 1:30.
  const reps = row(page, 'Weighted Pull-Ups', 3).locator('input.tracker-input--reps');
  await reps.click();
  await reps.pressSequentially('5');
  await expect(bar(page)).toHaveCount(0); // typing is not done
  await reps.press('Enter');
  await expect(bar(page)).toBeVisible();
  await expect(time(page)).toHaveText('1:30');
  await expect(bar(page).locator('.rest-timer__label')).toContainText('Weighted Pull-Ups');
  await expect(bar(page).getByRole('timer')).toHaveAttribute('aria-label', 'Rest, 90 seconds left');
  await shot(page, 'rest-timer');

  // Counts down on the clock.
  await page.clock.runFor(2_000);
  await expect(time(page)).toHaveText('1:28');

  // +15 s goes on the end.
  await bar(page).getByRole('button', { name: 'Add fifteen seconds of rest' }).click();
  await expect(time(page)).toHaveText('1:43');

  // The same row edited, even cleared and refilled, never restarts (R2.2).
  await reps.click();
  await reps.fill('6');
  await reps.press('Enter');
  await expect(time(page)).toHaveText('1:43');
  await reps.click();
  await reps.fill('');
  await reps.press('Enter');
  await reps.click();
  await reps.fill('7');
  await reps.press('Enter');
  await expect(time(page)).toHaveText('1:43');

  // Another row restarts with that exercise's rest: a range takes its low end (R2.5).
  const rowReps = row(page, 'Barbell Row', 3).locator('input.tracker-input--reps');
  await rowReps.click();
  await rowReps.fill('6');
  await rowReps.press('Enter');
  await expect(time(page)).toHaveText('2:00');
  await expect(bar(page).locator('.rest-timer__label')).toContainText('Barbell Row');

  // Skip clears it.
  await bar(page).getByRole('button', { name: 'Skip the rest' }).click();
  await expect(bar(page)).toHaveCount(0);

  // "as needed" is no timer and no default; weight alone is not a set done.
  const curl = row(page, 'Hammer Curl', 3).locator('input.tracker-input--reps');
  await curl.click();
  await curl.fill('12');
  await curl.press('Enter');
  await expect(bar(page)).toHaveCount(0);
  const carry = row(page, 'Farmer Carry', 3).locator('input.tracker-input--weight');
  await carry.click();
  await carry.fill('70');
  await carry.press('Enter');
  await expect(bar(page)).toHaveCount(0);

  // A duration row commits the same way: Enter in the stopwatch field.
  const plank = row(page, 'Plank', 3).locator('.tracker-duration');
  await plank.click();
  await plank.pressSequentially('30');
  await plank.press('Enter');
  await expect(plank).toHaveValue('30s');
  await expect(time(page)).toHaveText('1:00');
  await expect(bar(page).locator('.rest-timer__label')).toContainText('Plank');

  // Runs out: the bar goes, once.
  await page.clock.runFor(60_000);
  await expect(bar(page)).toHaveCount(0);
});

test('a tapped ghost row is a logged set, and a slept tab reads the right remaining', async ({ page }) => {
  await openTracker(page);

  // Set 1 carries last time's ghost; the tap commits it and starts the rest (R2.1).
  const ghostReps = row(page, 'Weighted Pull-Ups', 1).locator('input.tracker-input--reps');
  await expect(ghostReps).toHaveClass(/tracker-input--shadow/);
  await ghostReps.click();
  await expect(ghostReps).toHaveValue('8');
  await expect(time(page)).toHaveText('1:30');

  // Leaving the field is not a second commit.
  await page.clock.runFor(3_000);
  await expect(time(page)).toHaveText('1:27');
  await ghostReps.blur();
  await expect(time(page)).toHaveText('1:27');

  // The tab sleeps 30 s (no ticks fire, the clock jumps): the end is absolute.
  await page.clock.fastForward(30_000);
  await expect(time(page)).toHaveText('0:57');
  await shot(page, 'rest-timer-after-sleep');

  await page.clock.fastForward(56_000);
  await expect(time(page)).toHaveText('0:01');

  // Asleep well past the end: the stale countdown clears on return.
  await page.clock.fastForward(10 * 60_000);
  await expect(bar(page)).toHaveCount(0);
});

test('rows already logged when the tracker opens are spent (R2.4)', async ({ page }) => {
  await openTracker(page, bootstrap => {
    const pullups = bootstrap.groups[0].exercises.find(t => t.exercise.id === 'rt-1')!;
    Object.assign(pullups.sets[0], { actualReps: '5', isLogged: true, shadow: null });
  });

  const logged = row(page, 'Weighted Pull-Ups', 1).locator('input.tracker-input--reps');
  await expect(logged).toHaveValue('5');
  await logged.click();
  await logged.fill('6');
  await logged.press('Enter');
  await expect(bar(page)).toHaveCount(0);
  // Emptied, left, and filled again: still a correction, not a set.
  await logged.click();
  await logged.fill('');
  await logged.press('Enter');
  await expect(logged).toHaveValue('');
  await logged.click();
  await logged.fill('6');
  await logged.press('Enter');
  await expect(bar(page)).toHaveCount(0);

  // A fresh row of the same exercise still does.
  const fresh = row(page, 'Weighted Pull-Ups', 3).locator('input.tracker-input--reps');
  await fresh.click();
  await fresh.fill('5');
  await fresh.press('Enter');
  await expect(time(page)).toHaveText('1:30');
});
