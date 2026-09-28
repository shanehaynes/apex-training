import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

// "Ask the coach about this session" (D-C08): a button in the workout modal
// and one on the post-workout summary open the coach with that occurrence
// pinned. The pin is a hidden user turn: the request body's last user
// message carries the text the model reads, the thread shows only
// "Asked about: <title>, <date>", and the stored row keeps both halves.
// On a phone the ask lands on the Coach tab.

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

interface ChatBody { messages: Array<{ role: string; content: unknown }>; withTools: boolean; today: string }

/** Stub /api/chat with a text reply and collect every request body. */
function stubChat(page: Page): ChatBody[] {
  const bodies: ChatBody[] = [];
  void page.route('**/api/chat', route => {
    bodies.push(route.request().postDataJSON() as ChatBody);
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: ndjson([{ type: 'text', delta: 'I see a 30-minute stretch. How did it feel?' }, { type: 'done' }]),
    });
  });
  return bodies;
}

/** Every row the thread saved (the write-behind POST to /api/coach-conversations). */
function recordSaved(page: Page): Array<{ role: string; api_content: unknown; display_text: string | null }> {
  const rows: Array<{ role: string; api_content: unknown; display_text: string | null }> = [];
  page.on('request', req => {
    if (req.method() !== 'POST' || !req.url().includes('/api/coach-conversations')) return;
    const body = req.postDataJSON() as { messages?: typeof rows };
    if (body.messages) rows.push(...body.messages);
  });
  return rows;
}

/** The text of the last user message the model was sent. */
function lastUserText(body: ChatBody): string {
  const user = [...body.messages].reverse().find(m => m.role === 'user')!;
  if (typeof user.content === 'string') return user.content;
  return (user.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join('');
}

test('from the workout modal: the hidden text reaches the model, the thread shows the display line, the row stores both', async ({ page }) => {
  const bodies = stubChat(page);
  const saved = recordSaved(page);
  await gotoCalendar(page);

  await page.locator('.event-chip__main').first().click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  const title = (await modal.locator('#modal-title').textContent())!.trim();
  const { selectedEventId } = await apexState<{ selectedEventId: string | null }>(page, 'calendar');
  expect(selectedEventId).toBeTruthy();

  await page.getByTestId('ask-coach').click();

  // The modal closed, and the thread shows the display line — not the text.
  await expect(modal).toHaveCount(0);
  const userMsg = page.locator('.chat-msg--user').last();
  await expect(userMsg).toContainText(`Asked about: ${title}, `);
  await expect(userMsg).not.toContainText('get_workout_detail');
  await expect(page.locator('.chat-msg--assistant').last()).toContainText('How did it feel?');
  await shot(page, 'ask-coach-from-modal');

  // The wire: one tools-on chat call whose last user message is the pin.
  expect(bodies).toHaveLength(1);
  expect(bodies[0].withTools).toBe(true);
  const text = lastUserText(bodies[0]);
  expect(text).toContain(`I opened the workout "${title}" on `);
  expect(text).toContain(`(occurrence id ${selectedEventId}) from the calendar`);
  expect(text).toContain(`call get_workout_detail with event_id "${selectedEventId}"`);
  expect(text).toContain('get_session_summaries');
  expect(text).toContain('Keep to this session unless I widen the question myself.');
  expect(text).toContain('offer to remember it with the memory tool');

  // Stored as it was shown and sent: the display line, the hidden text.
  await expect.poll(() => saved.length).toBeGreaterThanOrEqual(2);
  const userRow = saved.find(r => r.role === 'user')!;
  expect(userRow.display_text).toContain(`Asked about: ${title}, `);
  expect(userRow.api_content).toBe(text);

  // The pin was consumed: nothing left to send.
  expect((await apexState<{ askCoachEventId: string | null }>(page, 'calendar')).askCoachEventId).toBeNull();
});

test('from the tracker summary: leaves the tracker and pins the session as just tracked', async ({ page }) => {
  const bodies = stubChat(page);
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  const title = (await page.locator('#modal-title').textContent())!.trim();
  await page.getByRole('button', { name: 'Start Workout' }).click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });
  await page.locator('.tracker-header__finish').click();
  await page.getByRole('button', { name: 'Finish anyway' }).click();
  await expect(page.locator('.tracker-summary')).toBeVisible();

  await page.getByTestId('ask-coach-summary').click();

  await expect(page.locator('.tracker')).toHaveCount(0);
  await expect(page.locator('.chat-msg--user').last()).toContainText(`Asked about: ${title}, `);
  await expect(page.locator('.chat-msg--assistant').last()).toContainText('How did it feel?');

  expect(bodies).toHaveLength(1);
  const text = lastUserText(bodies[0]);
  expect(text).toContain(`I just finished tracking the workout "${title}" on `);
  expect(text).toContain('and get_session_summaries for ');
  expect(text).not.toContain('if it was tracked');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the ask lands on the Coach tab', async ({ page }) => {
    const bodies = stubChat(page);
    await page.goto('/');
    await page.locator('.mobile-nav').waitFor({ state: 'visible', timeout: 20000 });
    await expect(page.locator('.app-shell')).toHaveAttribute('data-mobile-tab', 'calendar');

    await page.locator('.day-view').getByRole('button', { name: /^Open / }).first().click({ timeout: 20000 });
    await expect(page.locator('.modal')).toBeVisible();
    await page.getByTestId('ask-coach').click();

    await expect(page.locator('.app-shell')).toHaveAttribute('data-mobile-tab', 'coach');
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.chat-msg--user').last()).toBeVisible();
    await expect(page.locator('.chat-msg--user').last()).toContainText('Asked about: ');
    await expect(page.locator('.chat-msg--assistant').last()).toContainText('How did it feel?');
    expect(bodies).toHaveLength(1);
    await shot(page, 'ask-coach-phone');
  });
});
