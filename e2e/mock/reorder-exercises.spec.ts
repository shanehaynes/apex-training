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

  const position = mainCards(page).last().locator('.editor-card__position');
  await expect(position).toHaveValue('11');
  await position.selectOption({ label: '1' });
  await expect.poll(() => mainNames(page).then(n => n[0])).toBe('Band External Rotation');
  await shot(page, 'reorder-exercises-position');

  // And back down: Back Squat, now second, to the bottom.
  await mainCards(page).nth(1).locator('.editor-card__position').selectOption({ label: '12' });
  const names = await mainNames(page);
  expect(names[0]).toBe('Band External Rotation');
  expect(names[11]).toBe('Back Squat');

  await saveWholeSeries(page);
  const saved = patches.at(-1)?.body.fields?.exercises?.map(e => e.name);
  expect(saved?.[0]).toBe('Band External Rotation');
  expect(saved?.[11]).toBe('Back Squat');
});
