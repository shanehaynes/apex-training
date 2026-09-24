import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIPS, tipById } from '../../src/lib/onboarding/tips/index';

// The coach's two tips (docs/onboarding/workstreams/O10-coach.md):
// coach-first-message when a pane with a saved key and an empty thread is on
// screen — the desktop rail on load, the phone's Coach tab once opened — and
// coach-confirm-card on the first pending action. Plus the no-key state's
// link to /help/get-api-key.

test.use({ tips: 'on' });

const FIRST = tipById('coach-first-message');
const CONFIRM = tipById('coach-confirm-card');

const ndjson = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

/** This lane's tips; every other lane's is marked seen so it cannot take the load's one card. */
const COACH_IDS: readonly string[] = [FIRST.id, CONFIRM.id];
const OTHERS_SEEN: Record<string, string> = Object.fromEntries(
  TIPS.filter(t => !COACH_IDS.includes(t.id)).map(t => [t.id, '2026-09-01T00:00:00Z']),
);

/**
 * Answer the own-profile read with the fixture's row, every other lane's tip
 * seen, plus `seen`. A later call outranks an earlier one (Playwright matches
 * routes newest first), so a test can add to the beforeEach default.
 */
async function stubProfile(page: Page, seen: Record<string, string> = {}) {
  const row = { ...driverProfile(), tips_seen: { ...OTHERS_SEEN, ...seen } };
  await page.route(/\.supabase\.co\/rest\/v1\/profiles/, route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify(wantsObject ? row : [row]),
    });
  });
}

/** Key status as GET /api/profile reports it. */
async function stubKey(page: Page, hasAnthropicKey: boolean) {
  await page.route('**/api/profile', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify({
        hasAnthropicKey, anthropicKeyLast4: hasAnthropicKey ? 'abcd' : null,
        termsAccepted: null, termsCurrent: true,
      }),
    });
  });
}

/** Every PATCH /api/profile body the page sends. */
function recordProfilePatches(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', req => {
    if (req.method() === 'PATCH' && req.url().includes('/api/profile')) {
      bodies.push(req.postDataJSON() as Record<string, unknown>);
    }
  });
  return bodies;
}

const tip = (page: Page, id: string) => page.locator(`.tip[data-tip-id="${id}"]`);

// The calendar under every test offers its own tips (day-complete-circle
// ties coach-confirm-card on priority and wins on catalog order).
test.beforeEach(async ({ page }) => { await stubProfile(page); });

test('the desktop rail offers the first-message tip on load', async ({ page }) => {
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);

  const card = tip(page, FIRST.id);
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(FIRST.title);
  await expect(card.locator('.tip__text')).toContainText('Coach’s Notes');
  // No help page: the key is already there, the rail itself is the lesson.
  await expect(card.locator('.tip__link')).toHaveCount(0);
  await shot(page, 'tips-coach-first-message');

  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: FIRST.id });
});

test('no key: no tip, and the setup prompt links to the help page', async ({ page }) => {
  await stubKey(page, false);
  await gotoCalendar(page);

  await expect(page.locator('.chat-key-setup-btn')).toBeVisible();
  const link = page.locator('.chat-empty').getByRole('link', { name: 'How to get a key' });
  await expect(link).toHaveAttribute('href', '/help/get-api-key');
  await expect(link).toHaveAttribute('target', '_blank');
  await shot(page, 'tips-coach-no-key');

  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('a thread that already has messages gets no first-message tip', async ({ page }) => {
  await page.route('**/api/coach-conversations**', route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const conversation = {
      id: 'conv-old', mode: 'chat', title: null,
      created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z',
    };
    const body = req.url().includes('id=')
      ? {
        conversation,
        messages: [
          { id: 'm1', role: 'user', api_content: 'hi', display_text: 'hi', kind: 'turn', created_at: '2026-08-29T00:00:00.000Z' },
          { id: 'm2', role: 'assistant', api_content: 'Hello.', display_text: 'Hello.', kind: 'turn', created_at: '2026-08-29T00:00:01.000Z' },
        ],
      }
      : { conversations: [conversation] };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  });
  await gotoCalendar(page);

  await expect(page.locator('.chat-msg--assistant')).toHaveText('Hello.');
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('the first pending action shows the confirm-card tip', async ({ page }) => {
  // First-message already seen, or it would take this load's one tip.
  await stubProfile(page, { [FIRST.id]: '2026-09-01T00:00:00Z' });
  await page.route('**/api/chat', route => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson; charset=utf-8',
    body: ndjson([
      { type: 'text', delta: 'Adding it now.' },
      {
        type: 'tool_use', id: 'tu-1', name: 'create_event',
        input: { type: 'cardio', title: 'Easy Run', date: '2026-07-08', estimated_duration: 30 },
      },
      { type: 'done' },
    ]),
  }));
  const patches = recordProfilePatches(page);
  await gotoCalendar(page);

  // Nothing on offer yet: the thread is empty but its tip is seen.
  await page.waitForTimeout(1200);
  await expect(page.locator('.tip')).toHaveCount(0);

  const input = page.locator('.chat-input');
  await input.fill('add an easy run tomorrow');
  await input.press('Enter');
  const confirm = page.locator('.chat-confirm-card');
  await expect(confirm).toBeVisible();

  // The input had focus when Enter was pressed, and TipHost holds while an
  // input is focused — the card must still land.
  const card = tip(page, CONFIRM.id);
  await expect(card).toBeVisible();
  await expect(card.locator('.tip__title')).toHaveText(CONFIRM.title);
  await expect(card.locator('.tip__text')).toContainText('Confirm');
  await shot(page, 'tips-coach-confirm-card');

  await card.locator('.tip__ok').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => patches.find(b => 'tip_seen' in b)).toEqual({ tip_seen: CONFIRM.id });
  // The action is still waiting on the user.
  await expect(confirm.getByRole('button', { name: 'Confirm' })).toBeEnabled();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the first-message tip waits for the Coach tab', async ({ page }) => {
    await page.goto('/');
    await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });

    // The pane is mounted but hidden on the Calendar tab.
    await page.waitForTimeout(1200);
    await expect(page.locator('.tip')).toHaveCount(0);

    await page.locator('.mobile-nav__tab').nth(1).click();
    await expect(page.locator('.chat-sidebar__input-row')).toBeVisible();
    const card = tip(page, FIRST.id);
    await expect(card).toBeVisible();
    await shot(page, 'tips-coach-first-message-phone');
    await card.locator('.tip__ok').click();
    await expect(card).toHaveCount(0);
  });
});
