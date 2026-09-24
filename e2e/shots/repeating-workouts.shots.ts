// Screenshots for help/repeating-workouts.md ("Workouts that repeat").
//
//   APEX_PORT=<port> npx playwright test --project=shots-phone --project=shots-desktop \
//     e2e/shots/repeating-workouts.shots.ts
//
// Mock clock 2026-09-07 (a Monday). The seed's "Weights — Session A" repeats
// every Tuesday, which is the page's running example: "I changed Tuesday and
// it changed every Tuesday."

import type { Page, TestInfo } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';

const SLUG = 'repeating-workouts';
const SERIES = 'Weights — Session A';
/** Exploration only: write somewhere other than public/ (e2e/shots/README.md). */
const outDir = process.env.APEX_SHOTS_OUT;

const isPhone = (testInfo: TestInfo) => testInfo.project.name === 'shots-phone';

/** Steps whose desktop layout is the phone's, only wider, get no desktop variant. */
function phoneOnly(testInfo: TestInfo) {
  test.skip(!isPhone(testInfo), 'the desktop layout is the same picture');
}

async function load(page: Page, testInfo: TestInfo) {
  if (isPhone(testInfo)) {
    await page.goto('/');
    await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });
  } else {
    await gotoCalendar(page);
  }
}

/** Centre `el` in its scroller, so a ring drawn around it is not cut off by the screen edge. */
async function centre(page: Page, selector: string) {
  await page.locator(selector).evaluate(el => el.scrollIntoView({ block: 'center' }));
}

/**
 * The button just tapped is replaced in place by the choice, so the pointer
 * would otherwise leave one of the answers looking hovered.
 */
async function restMouse(page: Page) {
  await page.mouse.move(1, 1);
}

/** Open the Tuesday occurrence of the weekly series. */
async function openSeries(page: Page, testInfo: TestInfo) {
  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'Tuesday, September 8' }).click();
    await page.getByRole('button', { name: `Open ${SERIES}` }).click();
  } else {
    await page.locator('.event-chip__main', { hasText: SERIES }).first().click();
  }
  await expect(page.getByRole('dialog', { name: SERIES })).toBeVisible();
}

test('01 the repeat picker, on, with days and no end', async ({ page }, testInfo) => {
  phoneOnly(testInfo);
  await load(page, testInfo);

  // From the day, the way a new user adds anything: + → Workout.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // The driven profile has no coach goal, so the "Finish setting up" card
  // sits over the calendar — and over the + menu's items on a phone. Close
  // it (session-only) so the menu can be tapped.
  await page.locator('.setup-nudge__dismiss').click();
  await page.getByRole('menuitem', { name: 'Workout' }).click();
  await page.locator('.builder-search__create').click();
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill('Leg day');

  const picker = page.locator('.builder-repeat');
  await picker.scrollIntoViewIfNeeded();
  await page.locator('.builder-repeat__switch').click();
  await page.getByLabel('Repeat on TU').click();
  await page.getByLabel('Repeat on TH').click();
  await expect(page.locator('.builder-repeat__end-opt--active')).toHaveText('Never');
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').blur();
  await picker.scrollIntoViewIfNeeded();

  await helpShot(page, { slug: SLUG, n: 1, name: 'repeat-picker', highlight: picker, outDir });
});

test('02 a repeating workout, open', async ({ page }, testInfo) => {
  await load(page, testInfo);
  await openSeries(page, testInfo);

  // Ring Edit exercises: the row itself spans the modal and is mostly empty.
  // It is the button that reaches every week without asking.
  const editExercises = page.locator('.modal-edit-exercises');
  await expect(page.locator('.modal-edit-workout')).toBeVisible();
  await editExercises.scrollIntoViewIfNeeded();
  await helpShot(page, { slug: SLUG, n: 2, name: 'series-open', highlight: editExercises, outDir });
});

test('03 Edit exercises says it changes every week', async ({ page }, testInfo) => {
  phoneOnly(testInfo);
  await load(page, testInfo);
  await openSeries(page, testInfo);

  await page.locator('.modal-edit-exercises').click();
  const note = page.locator('.exercise-editor__series-note');
  await expect(note).toContainText('every occurrence');
  await note.scrollIntoViewIfNeeded();
  await helpShot(page, { slug: SLUG, n: 3, name: 'series-note', highlight: note, outDir });
});

test('04 Edit workout asks: this event only, or the whole series', async ({ page }, testInfo) => {
  phoneOnly(testInfo);
  await load(page, testInfo);
  await openSeries(page, testInfo);

  await page.locator('.modal-edit-workout').click();
  await page.locator('.library-field', { hasText: 'Location' }).locator('input').fill('Home gym');
  await page.locator('.exercise-editor__save', { hasText: 'Save changes' }).click();
  const scope = page.locator('.builder-scope');
  await expect(scope.getByRole('button', { name: 'This event only' })).toBeVisible();
  await expect(scope.getByRole('button', { name: 'Whole series' })).toBeVisible();
  // The Location field keeps focus otherwise, and the caret would ride along.
  await page.locator('.library-field', { hasText: 'Location' }).locator('input').blur();
  await centre(page, '.builder-scope');
  await restMouse(page);
  await helpShot(page, { slug: SLUG, n: 4, name: 'save-scope', highlight: scope, outDir });
});

test('05 Delete workout asks the same question', async ({ page }, testInfo) => {
  phoneOnly(testInfo);
  await load(page, testInfo);
  await openSeries(page, testInfo);

  await page.locator('.modal-delete').click();
  const confirm = page.locator('.modal-danger');
  await expect(confirm.getByRole('button', { name: 'This day only' })).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Whole series' })).toBeVisible();
  // The modal scrolls the confirm to its bottom edge; lift it clear.
  await centre(page, '.modal-danger');
  await restMouse(page);
  await helpShot(page, { slug: SLUG, n: 5, name: 'delete-scope', highlight: confirm, outDir });
});
