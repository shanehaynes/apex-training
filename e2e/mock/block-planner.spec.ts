import { test, expect, shot } from '../lib/fixtures';

// The block planner (coach initiative E01): Training blocks → "Plan with the
// coach" opens a planner thread against a scripted /api/chat. The tools-on
// call answers with reads narrated on the wire and one update_block_draft;
// the settle call (tools off) answers with text. The draft lands as cards —
// no confirmation card — and only the user's Apply posts the batch.
//
// The mock clock is 2026-09-07 (a Monday, playwright.config.ts), so the plan
// starts that week.

const PLAN = {
  blocks: [
    { name: 'Base', phase: 'base', intent: 'Aerobic foundation.', start_date: '2026-09-07', end_date: '2026-10-04', weekly_targets: { cardio_minutes: 300, vert: { value: 3000, unit: 'ft' } } },
    { name: 'Build', phase: 'build', start_date: '2026-10-05', end_date: '2026-11-01', weekly_targets: { cardio_minutes: 360, strength_sessions: 2 } },
    { name: 'Peak', phase: 'peak', start_date: '2026-11-02', end_date: '2026-11-22', weekly_targets: { long_session_minutes: 300 } },
    { name: 'Taper', phase: 'taper', start_date: '2026-11-23', end_date: '2026-11-29', weekly_targets: { cardio_minutes: 150 } },
  ],
};

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('the coach drafts the blocks, the user trims and applies them as one batch', async ({ page }) => {
  const chatBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/chat', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    chatBodies.push(body);
    const events = body.withTools
      ? [
          { type: 'text', delta: 'Reading your blocks and the doctrine.' },
          { type: 'tool_read', id: 'tr-1', name: 'get_training_blocks', input: {}, label: 'Checked: training blocks' },
          { type: 'tool_read', id: 'tr-2', name: 'read_doctrine', input: { topic: 'periodization' }, label: 'Doctrine: Periodization toward an objective' },
          { type: 'tool_read_result', id: 'tr-1', text: '{"blocks":[]}', isError: false },
          { type: 'tool_read_result', id: 'tr-2', text: 'Periodization…', isError: false },
          { type: 'text', delta: ' Twelve weeks, four phases.' },
          { type: 'tool_use', id: 'tu-1', name: 'update_block_draft', input: PLAN },
          { type: 'done' },
        ]
      : [
          { type: 'text', delta: 'Base builds the engine; taper lands on the objective. Review and press Apply.' },
          { type: 'done' },
        ];
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: ndjson(events) });
  });

  // The commit: one batched POST. page.route outranks the context-wide stub,
  // so the body can be read back here.
  const batchBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/blocks?*', route => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().includes('batch=1')) {
      batchBodies.push(req.postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ids: ['b1', 'b2', 'b3'] }) });
    }
    return route.fallback();
  });

  await page.goto('/');
  await expect(page.locator('.top-nav')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('nav-blocks').click();
  await expect(page.locator('.library-header__title')).toHaveText('Training blocks');

  await page.getByTestId('plan-with-coach').click();
  await expect(page.locator('.library-header__title')).toHaveText('Plan with the coach');
  await expect(page.getByTestId('block-draft-empty')).toBeVisible();
  await expect(page.getByTestId('block-planner-apply')).toBeDisabled();

  await page.locator('.block-planner__coach .chat-input').fill('12 weeks to Denali: base, build, peak, taper');
  await page.locator('.block-planner__coach .chat-send-btn').click();

  // The settle text lands after the auto-applied update — no confirm card —
  // and the reads show as chips on the reply.
  await expect(page.locator('.block-planner__coach .chat-msg--assistant').last()).toContainText('press Apply');
  await expect(page.locator('.chat-confirm-card')).toHaveCount(0);
  await expect(page.locator('.block-planner__coach .chat-reads__chip')).toHaveText([
    'Checked: training blocks',
    'Doctrine: Periodization toward an objective',
  ]);

  // Four cards, in order, with the range, the phase and the targets.
  const cards = page.getByTestId('block-draft-card');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('Base');
  await expect(cards.nth(0)).toContainText('Sep 7 – Oct 4, 2026 · 4 weeks');
  await expect(cards.nth(0)).toContainText('3,000 ft');
  await expect(page.locator('.block-planner__phase')).toHaveText(['base', 'build', 'peak', 'taper']);
  await expect(page.locator('.library-header__count')).toHaveText('4 blocks drafted');
  await shot(page, 'block-planner-drafted');

  // The wire (v2): planner mode, the draft as of now, tools on then off.
  expect(chatBodies[0].mode).toBe('planner');
  expect(chatBodies[0].today).toBe('2026-09-07');
  expect(chatBodies[0].system).toBeUndefined();
  expect((chatBodies[0].context as { draft: { editingId: null; blocks: unknown[] } }).draft).toEqual({ editingId: null, blocks: [] });
  expect(chatBodies[0].withTools).toBe(true);
  expect(chatBodies[1].withTools).toBe(false);
  // The settle carries the reducer's summary as the tool_result.
  const settleMessages = chatBodies[1].messages as Array<{ role: string; content: unknown }>;
  const lastUser = settleMessages[settleMessages.length - 1];
  expect(JSON.stringify(lastUser.content)).toContain('Block draft updated: 4 blocks, Sep 7 – Nov 29 (base 4w · build 4w · peak 3w · taper 1w). The user reviews and presses Apply.');

  // The user trims the peak, then applies: nothing was written before this.
  expect(batchBodies).toHaveLength(0);
  await cards.nth(2).getByRole('button', { name: 'Remove Peak from the draft' }).click();
  await expect(cards).toHaveCount(3);
  const apply = page.getByTestId('block-planner-apply');
  await expect(apply).toHaveText('Apply 3 blocks');
  await apply.click();

  await expect.poll(() => batchBodies.length, { message: 'exactly one batched POST' }).toBe(1);
  const rows = batchBodies[0].rows as Array<Record<string, unknown>>;
  expect(rows.map(r => r.name)).toEqual(['Base', 'Build', 'Taper']);
  expect(rows[0]).toMatchObject({
    name: 'Base', phase: 'base', intent: 'Aerobic foundation.', objective_id: null,
    start_date: '2026-09-07', end_date_exclusive: '2026-10-05',
    weekly_targets: { cardioMinutes: 300, vert: { value: 3000, unit: 'ft' } },
  });
  expect(rows[2]).toMatchObject({ start_date: '2026-11-23', end_date_exclusive: '2026-11-30', weekly_targets: { cardioMinutes: 150 } });
  expect(batchBodies[0].log).toEqual({ resource_name: 'Base', triggered_by: 'user' });

  // Back to the list.
  await expect(page.locator('.library-header__title')).toHaveText('Training blocks');
});

test('a tool the planner does not have is cancelled, and Cancel discards the draft', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls += 1;
    const events = body.withTools
      ? [{ type: 'tool_use', id: 'tu-x', name: 'create_event', input: { title: 'Long run', date: '2026-09-12', type: 'cardio', estimated_duration: 120 } }, { type: 'done' }]
      : [{ type: 'text', delta: 'Understood — I can only edit the block draft here.' }, { type: 'done' }];
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: ndjson(events) });
  });

  await page.goto('/');
  await expect(page.locator('.top-nav')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('nav-blocks').click();
  await page.getByTestId('plan-with-coach').click();

  await page.locator('.block-planner__coach .chat-input').fill('schedule a long run saturday');
  await page.locator('.block-planner__coach .chat-send-btn').click();
  await expect(page.locator('.block-planner__coach .chat-msg--assistant').last()).toContainText('only edit the block draft');
  // Cancelled without a card and without touching the draft.
  await expect(page.locator('.chat-confirm-card')).toHaveCount(0);
  await expect(page.getByTestId('block-draft-empty')).toBeVisible();
  expect(calls).toBe(2);

  await page.locator('.block-planner__actions .library-editor__cancel').click();
  await expect(page.locator('.library-header__title')).toHaveText('Training blocks');
});
