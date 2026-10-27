import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// Reordering a long section in the exercise editor. Weights — Session B has
// twelve main exercises under nine warm-ups, so the modal has to scroll to
// reach the last one. Dragging it to the top must keep going while the modal
// auto-scrolls past cards that were off screen at pick-up, and the position
// picker moves a card anywhere in one step. Either way the saved order is
// the new one.

interface Patch { id: string | null; body: { fields?: { exercises?: Array<{ name: string }> } } }

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

const mainCards = (page: Page) => page.locator('.exercise-editor .modal-section').nth(1).locator('.editor-card');
const mainNames = (page: Page) => mainCards(page).locator('.editor-card__name').allTextContents();

async function openSessionB(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main', { hasText: 'Session B' }).first().click();
  await page.locator('.modal-edit-exercises').click();
  await expect(mainCards(page)).toHaveCount(12);
  expect((await mainNames(page))[11]).toBe('Band External Rotation');
}

async function saveWholeSeries(page: Page) {
  await page.locator('.exercise-editor__save', { hasText: 'Save exercises' }).click();
  await page.locator('.exercise-editor__save', { hasText: 'Whole series' }).click();
  await expect(page.locator('.exercise-editor')).toHaveCount(0);
}

test('drag the last exercise to the top of a long, scrolled list', async ({ page }) => {
  const patches = watchPatches(page);
  await openSessionB(page);

  const last = mainCards(page).last();
  await last.scrollIntoViewIfNeeded();
  await expect(mainCards(page).first(), 'the top of the list is scrolled away').not.toBeInViewport();

  const grip = (await last.locator('.editor-card__grip').boundingBox())!;
  const modal = (await page.locator('.modal').boundingBox())!;
  const x = grip.x + grip.width / 2;
  await page.mouse.move(x, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, grip.y - 20, { steps: 4 });
  // Hold near the modal's top edge: it scrolls on its own, no jiggling.
  await page.mouse.move(x, modal.y + 10, { steps: 20 });
  await expect.poll(() => page.locator('.modal').evaluate(el => el.scrollTop), { timeout: 10000 }).toBe(0);
  await page.mouse.move(x, modal.y + 12, { steps: 2 });
  await shot(page, 'reorder-exercises-dragging');
  await page.mouse.up();

  await expect.poll(() => mainNames(page).then(n => n[0])).toBe('Band External Rotation');
  const names = await mainNames(page);
  expect(names[1]).toBe('Back Squat');
  expect(names).toHaveLength(12);

  await saveWholeSeries(page);
  const saved = patches.at(-1)?.body.fields?.exercises?.map(e => e.name);
  expect(saved?.[0], 'the new order is what saves').toBe('Band External Rotation');
  expect(saved?.[1]).toBe('Back Squat');
});

test('the position picker moves an exercise anywhere in one step', async ({ page }) => {
  const patches = watchPatches(page);
  await openSessionB(page);

  const position = mainCards(page).last().locator('.reorder-position');
  await expect(position).toHaveValue('11');
  await position.selectOption({ label: '1' });
  await expect.poll(() => mainNames(page).then(n => n[0])).toBe('Band External Rotation');
  await shot(page, 'reorder-exercises-position');

  // And back down: Back Squat, now second, to the bottom.
  await mainCards(page).nth(1).locator('.reorder-position').selectOption({ label: '12' });
  const names = await mainNames(page);
  expect(names[0]).toBe('Band External Rotation');
  expect(names[11]).toBe('Back Squat');

  await saveWholeSeries(page);
  const saved = patches.at(-1)?.body.fields?.exercises?.map(e => e.name);
  expect(saved?.[0]).toBe('Band External Rotation');
  expect(saved?.[11]).toBe('Back Squat');
});

test('the keyboard moves a card, and Escape cancels the move without closing the editor', async ({ page }) => {
  const patches = watchPatches(page);
  await openSessionB(page);
  const before = await mainNames(page);

  // An unsaved edit that a stray Escape reaching the modal would throw away.
  const reps = mainCards(page).first().locator('.editor-field', { hasText: 'Reps' }).locator('input');
  await reps.fill('5');

  const lastGrip = mainCards(page).last().locator('.editor-card__grip');
  await lastGrip.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(page.locator('.exercise-editor'), 'Escape cancels the drag, not the editor').toBeVisible();
  expect(await mainNames(page)).toEqual(before);
  await expect(reps).toHaveValue('5');

  // Pick up, move up three places, drop.
  await lastGrip.focus();
  await page.keyboard.press('Space');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Space');
  await expect.poll(() => mainNames(page).then(n => n.indexOf('Band External Rotation'))).toBe(8);

  await saveWholeSeries(page);
  const saved = patches.at(-1)?.body.fields?.exercises?.map(e => e.name);
  expect(saved?.[8]).toBe('Band External Rotation');
});

// Mid-workout: the rack is free, so the last exercise moves to the top of
// the live tracker. The order saves with this session only (exerciseOrder on
// the save op), never as an edit to the plan.
test('mid-workout, the position picker moves an exercise and saves the session order', async ({ page }) => {
  const patches = watchPatches(page);
  const saves: Array<{ exerciseOrder?: { exercise?: string[] } }> = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname !== '/api/workout-sessions' || req.method() !== 'POST') return;
    const body = req.postDataJSON();
    if (body?.action === 'save') saves.push(body);
  });

  await gotoCalendar(page);
  await page.locator('.event-chip__main', { hasText: 'Session B' }).first().click();
  await page.locator('.modal-completion__btn--start').click();
  const main = page.locator('.tracker-sortable-list').nth(1).locator(':scope > .tracker-sortable');
  await expect(main).toHaveCount(12, { timeout: 15000 });
  const names = () => main.locator('.tracker-exercise__name').allTextContents();
  expect((await names())[11]).toContain('Band External Rotation');

  await main.last().locator('.reorder-position').selectOption({ label: '1' });
  await expect.poll(() => names().then(n => n[0])).toContain('Band External Rotation');
  expect((await names())[1]).toContain('Back Squat');
  await shot(page, 'reorder-exercises-tracker');

  await expect.poll(() => saves.find(s => s.exerciseOrder)?.exerciseOrder?.exercise?.length, { timeout: 10000 }).toBe(12);
  expect(patches, 'the plan is not edited').toHaveLength(0);
});
