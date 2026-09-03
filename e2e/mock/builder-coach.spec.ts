import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// The builder's embedded coach, against a scripted /api/chat: first call
// (tools on) answers with one update_workout_draft tool_use; the settle
// call (tools off) answers with plain text. The panel auto-applies the
// draft update — no confirmation card — and only the user can Apply.

const DRAFT_UPDATE = {
  title: 'CINDY',
  scoring_type: 'amrap',
  time_cap_minutes: 20,
  exercises: [
    { name: 'Pull-up', reps: '5', superset: 'A' },
    { name: 'Push-up', reps: '10', superset: 'A' },
    { name: 'Air Squat', reps: '15' },
  ],
  repeat: { days: ['MO', 'WE', 'FR'], interval_weeks: 1 },
};

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('the coach panel fills the whole draft and cannot apply it', async ({ page }) => {
  const chatBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/chat', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    chatBodies.push(body);
    const events = body.withTools
      ? [
          { type: 'tool_use', id: 'tu-1', name: 'update_workout_draft', input: DRAFT_UPDATE },
          { type: 'done' },
        ]
      : [
          { type: 'text', delta: 'Draft filled — review it and press Apply when ready.' },
          { type: 'done' },
        ];
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: ndjson(events),
    });
  });
  await gotoCalendar(page);

  await page.getByTestId('nav-add-workout').click();
  await page.locator('.builder-search__create').click();

  // The coach hides behind its header toggle.
  await expect(page.locator('.builder-coach')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show coach' }).click();
  await expect(page.locator('.builder-coach')).toBeVisible();

  await page.locator('.builder-coach .chat-input').fill('Set up CINDY for me');
  await page.locator('.builder-coach .chat-send-btn').click();

  // The follow-up text lands after the auto-applied update — no confirm card.
  await expect(page.locator('.builder-coach .chat-msg--assistant')).toContainText('press Apply');
  await expect(page.locator('.chat-confirm-card')).toHaveCount(0);

  // Every form region followed the tool call.
  await expect(page.locator('.library-field', { hasText: 'Title' }).locator('input')).toHaveValue('CINDY');
  await expect(page.locator('.builder-scoring__btn--active')).toHaveText('AMRAP');
  await expect(page.locator('.builder-scoring__cap input')).toHaveValue('20');
  await expect(page.locator('.composer-exercises')).toContainText('Pull-up');
  await expect(page.locator('.superset-badge')).toHaveCount(2);
  await expect(page.locator('.builder-repeat__switch')).toHaveText('On');
  await expect(page.getByLabel('Repeat on WE')).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'builder-coach-filled');

  // The wire (v2): builder mode + the draft as of now on the tools-on call —
  // the server builds the prompt — tools off on the settle.
  expect(chatBodies[0].mode).toBe('builder');
  expect(chatBodies[0].today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(chatBodies[0].system).toBeUndefined();
  expect((chatBodies[0].context as { draft: Record<string, unknown> }).draft).toBeTruthy();
  expect(chatBodies[0].withTools).toBe(true);
  expect(chatBodies[1].withTools).toBe(false);

  // Nothing was written anywhere — the draft is the only thing that changed.
  // (Apply is still the user's: the button sits enabled under their finger.)
  await expect(page.locator('.exercise-editor__save')).toHaveText('Apply');
});
