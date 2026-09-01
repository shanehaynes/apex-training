import { test, expect, gotoCalendar } from '../lib/fixtures';

// The coach model picker: the one control that changes what the user pays,
// since the coach runs on their own Anthropic key. Proves the whole client
// path — the header renders the catalog, a pick PATCHes the profile, and the
// next turn actually asks /api/chat for that model.

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

const HAIKU = 'claude-haiku-4-5-20251001';

test('the coach header offers the model catalog, priced', async ({ page }) => {
  await gotoCalendar(page);

  const picker = page.locator('.chat-sidebar__model-select');
  await expect(picker).toBeVisible();

  // Every option carries its $/MTok — the saving has to be visible at the
  // point of choice, or the picker is just a model name.
  const options = await picker.locator('option').allTextContents();
  expect(options).toEqual([
    'Opus 5 · $5/$25 per Mtok',
    'Opus 4.8 · $5/$25 per Mtok',
    'Sonnet 5 · $3/$15 per Mtok',
    'Haiku 4.5 · $1/$5 per Mtok',
  ]);

  // A user who has never chosen sits on the app default, not a blank select.
  await expect(picker).toHaveValue('claude-opus-4-8');
});

test('picking a model saves it and sends it with the next turn', async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  await page.route('**/api/profile', route => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON() as Record<string, unknown>);
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, hasAnthropicKey: true, anthropicKeyLast4: 'abcd' }),
    });
  });

  const chatBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/chat', route => {
    chatBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: ndjson([{ type: 'text', delta: 'On it.' }, { type: 'done' }]),
    });
  });

  await gotoCalendar(page);

  await page.locator('.chat-sidebar__model-select').selectOption(HAIKU);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(patches.at(-1)).toMatchObject({ coach_model: HAIKU });

  // The optimistic local apply means the next turn uses the new model with
  // no reload — the regression this guards is a stale memoized callback
  // still sending the previous one.
  await page.locator('.chat-input').fill('what should I do today?');
  await page.locator('.chat-input').press('Enter');

  await expect.poll(() => chatBodies.length).toBeGreaterThan(0);
  expect(chatBodies.at(-1)).toMatchObject({ model: HAIKU });
});
