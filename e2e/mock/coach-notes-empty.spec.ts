import { test, expect, gotoCalendar } from '../lib/fixtures';

// Coach's Notes on a blank account: the model has nothing to brief on and,
// with tools off, nothing to read, so the stream carries no text. The thread
// used to render that as an empty assistant bubble. Now it is a notice with
// no history behind it — stored display-only, so a reload shows the same.

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test("an empty briefing shows a notice, not an empty bubble, and stores no history", async ({ page }) => {
  await page.route('**/api/chat', route => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson; charset=utf-8',
    body: ndjson([{ type: 'done' }]),
  }));
  const saved: Array<{ role: string; api_content: unknown; display_text: string | null; kind?: string }> = [];
  page.on('request', req => {
    if (req.method() !== 'POST' || !req.url().includes('/api/coach-conversations')) return;
    const body = req.postDataJSON() as { messages?: typeof saved };
    if (body.messages) saved.push(...body.messages);
  });
  await gotoCalendar(page);

  await page.getByRole('button', { name: "Coach's Notes" }).click();

  const bubble = page.locator('.chat-msg--assistant');
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator('.chat-msg__text')).toContainText('Nothing to brief on yet');

  // The notice is the only row: no hidden prompt, no empty assistant turn.
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ role: 'assistant', api_content: null, kind: 'notice' });
  expect(saved[0].display_text).toContain('Nothing to brief on yet');
});
