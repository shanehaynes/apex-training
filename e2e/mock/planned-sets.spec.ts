import { createRequire } from 'node:module';
import type { Locator, Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';

// Per-set targets are authored in the exercise editor: the "Per-set targets"
// disclosure on a card shows one row per set, a preset fills the rows (here
// a ramp), the rows stay editable, a base-prescription edit keeps them, and
// the tracker — which already honoured plannedSets — renders what was
// authored. "Apply to all sets" and "Remove per-set targets" are the only
// ways back to uniform rows / no rows.

interface Patch { id: string | null; body: { fields?: { exercises?: Array<{ id: string; plannedSets?: unknown }> } } }

function watchPatches(page: Page) {
  const patches: Patch[] = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.pathname === '/api/events' && req.method() === 'PATCH') {
      patches.push({ id: url.searchParams.get('id'), body: req.postDataJSON() });
    }
  });
  return patches;
}

const seed = createRequire(import.meta.url)('../../src/data/schedule.json') as {
  events: Array<{ id: string } & Record<string, unknown>>;
};

/**
 * The server's bootstrap plans from the event row the PATCH wrote; the
 * shared stub plans from the seed. Replay the PATCHes this page sent over
 * the seed event, through the stub's own `event` hook, so the tracker sees
 * what the editor saved.
 */
async function bootstrapFromPatches(page: Page, patches: Patch[]) {
  await page.route('**/api/workout-sessions', route => {
    const body = (route.request().postDataJSON() ?? {}) as { eventId?: string };
    const baseId = String(body.eventId ?? '').split('__')[0];
    const base = seed.events.find(e => e.id === baseId);
    const fields = patches.filter(p => p.id === baseId).reduce((acc, p) => ({ ...acc, ...p.body.fields }), {});
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sessionResponse(body, { event: base ? { ...base, ...fields } : null })),
    });
  });
}

const values = (cells: Locator) => cells.evaluateAll(els => els.map(el => (el as HTMLInputElement).value));

test('a ramp authored in the editor is what the tracker plans', async ({ page }) => {
  const patches = watchPatches(page);
  await bootstrapFromPatches(page, patches);
  await gotoCalendar(page);

  // Weights — Session A repeats on Tuesdays; Weighted Pull-Ups is 4 × 4–6 at ~35 lbs.
  await page.locator('.event-chip__main', { hasText: 'Session A' }).first().click();
  await page.locator('.modal-edit-exercises').click();
  const card = page.locator('.editor-card', { hasText: 'Weighted Pull-Ups' });
  await expect(card).toBeVisible();

  // Closed by default when nothing is authored; opens onto the base repeated.
  const toggle = card.locator('.planned-sets__toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const rows = card.locator('.planned-sets__row');
  const weightCells = rows.locator('input[aria-label$="weight"]');
  const repsCells = rows.locator('input[aria-label$="reps"]');
  await expect(rows).toHaveCount(4);
  await expect(card.locator('.planned-sets__table thead th')).toHaveText(['Set', 'Weight', 'Reps']);
  expect(await values(weightCells)).toEqual(['~35 lbs', '~35 lbs', '~35 lbs', '~35 lbs']);
  await expect(card.locator('.planned-sets__badge')).toHaveCount(0);

  // Ramp 20 → 35: the unit comes off the base weight.
  const ramp = async () => {
    await card.locator('.planned-sets__preset', { hasText: 'Ramp' }).click();
    const form = card.locator('.planned-sets__form');
    await form.getByLabel('Field').selectOption('targetWeight');
    await form.getByLabel('First').fill('20');
    await form.getByLabel('Last').fill('35');
    await form.locator('.planned-sets__fill').click();
    await expect(form).toHaveCount(0);
  };
  await ramp();
  expect(await values(weightCells)).toEqual(['20 lbs', '25 lbs', '30 lbs', '35 lbs']);
  expect(await values(repsCells)).toEqual(['4–6', '4–6', '4–6', '4–6']);
  await expect(card.locator('.planned-sets__badge')).toHaveText('4 sets authored');
  await shot(page, 'planned-sets-ramp');

  // Apply to all sets is the explicit way back to the base; Remove drops the rows.
  await card.locator('.planned-sets__action', { hasText: 'Apply to all sets' }).click();
  expect(await values(weightCells)).toEqual(['~35 lbs', '~35 lbs', '~35 lbs', '~35 lbs']);
  await card.locator('.planned-sets__action', { hasText: 'Remove per-set targets' }).click();
  await expect(card.locator('.planned-sets__badge')).toHaveCount(0);
  await expect(card.locator('.planned-sets__action')).toHaveCount(0);

  // Ramp again, then edit the base: the rows stay, and the table follows the set count.
  await ramp();
  await card.locator('.editor-field', { hasText: 'Reps' }).locator('input').fill('5');
  expect(await values(weightCells)).toEqual(['20 lbs', '25 lbs', '30 lbs', '35 lbs']);
  expect(await values(repsCells), 'authored rows are not rewritten by a base edit').toEqual(['4–6', '4–6', '4–6', '4–6']);
  await card.locator('.editor-field', { hasText: 'Sets' }).locator('input').fill('5');
  await expect(rows).toHaveCount(5);
  expect(await values(weightCells)).toEqual(['20 lbs', '25 lbs', '30 lbs', '35 lbs', '35 lbs']);

  // Rows stay editable after a preset.
  await rows.nth(4).locator('input[aria-label$="weight"]').fill('37.5 lbs');
  expect(await values(weightCells)).toEqual(['20 lbs', '25 lbs', '30 lbs', '35 lbs', '37.5 lbs']);

  // Save to the whole series: the PATCH carries the rows.
  await page.locator('.exercise-editor__save', { hasText: 'Save exercises' }).click();
  await page.locator('.exercise-editor__save', { hasText: 'Whole series' }).click();
  await expect(page.locator('.exercise-editor')).toHaveCount(0);
  expect(patches).toHaveLength(1);
  const saved = patches[0].body.fields?.exercises?.find(e => e.id === 'stuart-a-3');
  expect(saved?.plannedSets).toEqual([
    { setNumber: 1, targetWeight: '20 lbs', targetReps: '4–6' },
    { setNumber: 2, targetWeight: '25 lbs', targetReps: '4–6' },
    { setNumber: 3, targetWeight: '30 lbs', targetReps: '4–6' },
    { setNumber: 4, targetWeight: '35 lbs', targetReps: '4–6' },
    { setNumber: 5, targetWeight: '37.5 lbs', targetReps: '4–6' },
  ]);

  // Reopening the editor finds the rows authored and the disclosure open.
  await page.locator('.modal-edit-exercises').click();
  await expect(card.locator('.planned-sets__toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.planned-sets__badge')).toHaveText('5 sets authored');
  await page.locator('.exercise-editor__cancel', { hasText: 'Cancel' }).click();

  // The tracker plans each set from the authored row, not the base.
  await page.locator('.modal-completion__btn--start').click();
  const tracked = page.locator('.tracker-exercise', { has: page.locator('.tracker-exercise__name', { hasText: 'Weighted Pull-Ups' }) });
  await expect(tracked.locator('.tracker-set:not(.tracker-set--head)')).toHaveCount(5, { timeout: 15000 });
  await expect(tracked.locator('.tracker-set:not(.tracker-set--head) .tracker-set__planned'))
    .toHaveText(['20 lbs × 4–6', '25 lbs × 4–6', '30 lbs × 4–6', '35 lbs × 4–6', '37.5 lbs × 4–6']);
  await shot(page, 'planned-sets-tracker');
});

test('pyramid and top-set presets fill the column they are asked for', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main', { hasText: 'Session A' }).first().click();
  await page.locator('.modal-edit-exercises').click();

  // Clean and Jerk: 4 sets, reps "pyramid to 3–5", ~115 lbs — a reps pyramid.
  const clean = page.locator('.editor-card', { hasText: 'Clean and Jerk' });
  await clean.locator('.planned-sets__toggle').click();
  await clean.locator('.planned-sets__preset', { hasText: 'Pyramid' }).click();
  const pyramid = clean.locator('.planned-sets__form');
  await pyramid.getByLabel('Field').selectOption('targetReps');
  await pyramid.getByLabel('Start').fill('5');
  await pyramid.getByLabel('Peak').fill('3');
  await pyramid.locator('.planned-sets__fill').click();
  expect(await values(clean.locator('.planned-sets__row input[aria-label$="reps"]'))).toEqual(['5', '4', '4', '5']);
  expect(await values(clean.locator('.planned-sets__row input[aria-label$="weight"]')))
    .toEqual(['~115 lbs (85% max)', '~115 lbs (85% max)', '~115 lbs (85% max)', '~115 lbs (85% max)']);

  // Pistol Squats: 3 sets at 15–20 lbs — a top set with two back-offs at 80%.
  const pistols = page.locator('.editor-card', { hasText: 'Pistol Squats' });
  await pistols.locator('.planned-sets__toggle').click();
  await pistols.locator('.planned-sets__preset', { hasText: 'Top set' }).click();
  const topset = pistols.locator('.planned-sets__form');
  await topset.getByLabel('Field').selectOption('targetWeight');
  await topset.getByLabel('Top').fill('20 lbs');
  await expect(topset.getByLabel('Back-offs')).toHaveValue('2');
  await expect(topset.getByLabel('At %')).toHaveValue('80');
  await topset.locator('.planned-sets__fill').click();
  expect(await values(pistols.locator('.planned-sets__row input[aria-label$="weight"]'))).toEqual(['20 lbs', '15 lbs', '15 lbs']);
  await shot(page, 'planned-sets-presets');
});
