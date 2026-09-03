import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// The tile builder's embedded coach, against a scripted /api/chat: first
// call (tools on) answers with one update_chart_draft tool_use; the settle
// call (tools off) answers with plain text. The panel auto-applies the
// chart-draft update — no confirmation card — and only the user can Save.

const CHART_UPDATE = {
  title: 'Weekly running mileage',
  chart_type: 'line',
  bucket: 'week',
  display_unit: 'mi',
  date_range: { kind: 'rolling', days: 90 },
  series: [{ id: 's1', measure: 'distance', sports: ['running'] }],
};

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('the coach configures the tile and cannot save it', async ({ page }) => {
  const chatBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/chat', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    chatBodies.push(body);
    const events = body.withTools
      ? [
          { type: 'tool_use', id: 'tu-1', name: 'update_chart_draft', input: CHART_UPDATE },
          { type: 'done' },
        ]
      : [
          { type: 'text', delta: 'Tile configured — review the preview and press Save when ready.' },
          { type: 'done' },
        ];
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: ndjson(events),
    });
  });
  await gotoCalendar(page);

  await page.getByTestId('nav-analytics').click();
  await page.getByTestId('analytics-new-tile').click();

  // The coach hides behind its header toggle.
  await expect(page.getByTestId('analytics-coach')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show coach' }).click();
  await expect(page.getByTestId('analytics-coach')).toBeVisible();

  await page.locator('.analytics-coach .chat-input').fill('Chart my weekly running mileage for the last 3 months');
  await page.locator('.analytics-coach .chat-send-btn').click();

  // The follow-up text lands after the auto-applied update — no confirm card.
  await expect(page.locator('.analytics-coach .chat-msg--assistant')).toContainText('press Save');
  await expect(page.locator('.chat-confirm-card')).toHaveCount(0);

  // Every form region followed the tool call, and the preview draws from it.
  await expect(page.getByTestId('tile-title')).toHaveValue('Weekly running mileage');
  await expect(page.getByRole('radio', { name: 'Distance', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'mi', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /Filters/ }).click();
  await expect(
    page.locator('.an-chips[aria-label="Sports"] .an-chip', { hasText: 'Running' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tile-preview').locator('svg')).toBeVisible();
  await shot(page, 'analytics-coach-filled');

  // The wire (v2): analytics mode + the chart draft as of now on the tools-on
  // call — the server builds the prompt — tools off on the settle.
  expect(chatBodies[0].mode).toBe('analytics');
  expect(chatBodies[0].today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(chatBodies[0].system).toBeUndefined();
  expect((chatBodies[0].context as { draft: Record<string, unknown> }).draft).toBeTruthy();
  expect(chatBodies[0].withTools).toBe(true);
  expect(chatBodies[1].withTools).toBe(false);

  // Nothing was written anywhere — Save is still the user's.
  await expect(page.getByTestId('tile-save')).toHaveText('Save tile');
});
