import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// The coach's confirmation card shows what will change: a before/after block
// (src/lib/coach/preview.ts) under the one-line label. Two shapes matter to
// the UI: a preview that resolves against the bundled seed (the label, the
// diff, both buttons), and one that cannot — a model-supplied id no live row
// matches — where the card must render exactly as it did before previews,
// label and buttons alone.

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

function stubChat(page: Page, toolUses: object[]) {
  return page.route('**/api/chat', route => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson; charset=utf-8',
    body: ndjson([
      { type: 'text', delta: 'On it.' },
      ...toolUses.map((tu, i) => ({ type: 'tool_use', id: `tu-${i + 1}`, ...tu })),
      { type: 'done' },
    ]),
  }));
}

test('an update on a seeded workout shows the fields that change, before and after', async ({ page }) => {
  // w1-mon-stretch: "Nightly Stretch — Upper", 2026-06-22, 30 min, 9:30 PM in src/data/schedule.json.
  await stubChat(page, [{
    name: 'update_event',
    input: { event_id: 'w1-mon-stretch', event_title: 'Nightly Stretch — Upper', changes: { estimated_duration: 45, start_time: '9:00 PM' } },
  }]);
  await gotoCalendar(page);

  await page.locator('.chat-input').fill('make tonight\'s stretch 45 minutes at 9');
  await page.locator('.chat-input').press('Enter');

  const card = page.locator('.chat-confirm-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.chat-confirm-card__label')).toContainText('Update: Nightly Stretch — Upper');

  const preview = card.getByTestId('confirm-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-kind', 'event-update');
  await expect(preview.locator('.confirm-preview__field')).toHaveText(['Duration', 'Start']);
  await expect(preview.locator('.confirm-preview__before')).toHaveText(['30 min', '9:30 PM']);
  await expect(preview.locator('.confirm-preview__after')).toHaveText(['45 min', '9:00 PM']);

  await expect(card.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  await shot(page, 'coach-confirm-preview-update');
});

test('a create lists the exercises the workout will hold', async ({ page }) => {
  await stubChat(page, [{
    name: 'create_event',
    input: {
      type: 'weights', title: 'Lower Body', date: '2026-07-10', estimated_duration: 50, start_time: '7:00 AM',
      exercises: [{ name: 'Goblet Squat', sets: 3, reps: '10', weight: '24kg' }, { name: 'Walking Lunge', sets: 2, reps: '12 each leg' }],
    },
  }]);
  await gotoCalendar(page);

  await page.locator('.chat-input').fill('add a lower body day friday');
  await page.locator('.chat-input').press('Enter');

  const preview = page.locator('.chat-confirm-card').getByTestId('confirm-preview');
  await expect(preview).toHaveAttribute('data-kind', 'event-create');
  await expect(preview.locator('.confirm-preview__line')).toContainText('Fri Jul 10 · 7:00 AM · 50 min · weights');
  // The mock stack serves no library, so every name is a new entry.
  await expect(preview.locator('li')).toHaveText([
    'Goblet Squat (new) · 3 × 10 · 24kg',
    'Walking Lunge (new) · 2 × 12 each leg',
  ]);
});

test('a target no live row matches renders the card exactly as before: label, queue line, buttons, no preview', async ({ page }) => {
  await stubChat(page, [
    { name: 'update_event', input: { event_id: 'no-such-event', event_title: 'Ghost', changes: { title: 'Boo' } } },
    { name: 'delete_meal', input: { meal_id: 'no-such-meal', meal_title: 'Ghost meal' } },
  ]);
  await gotoCalendar(page);

  await page.locator('.chat-input').fill('rename it');
  await page.locator('.chat-input').press('Enter');

  const card = page.locator('.chat-confirm-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.chat-confirm-card__label')).toContainText('no matching entry for id "no-such-event"');
  await expect(card.locator('.chat-confirm-card__queue')).toContainText('1 more after this');
  await expect(card.getByTestId('confirm-preview')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeEnabled();
});
