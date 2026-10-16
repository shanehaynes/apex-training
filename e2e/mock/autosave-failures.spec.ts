import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';

// The save queue's toasts, through the real tracker: useWorkoutSession's
// buildSend decides which failed autosave tells the user (saveLogs only
// throws — autosaveFailureToast is unit-tested; these pin the wiring). Each
// case fails if its line in buildSend breaks: the streak flag, the auth
// branch, the single-key refusal, the cancel guard. Not covered: the
// keepalive hand-off — Playwright cannot see fetch's keepalive flag.

interface SessionBody { action?: string }
type Reply = { status: number; body?: string };

const CORS = { 'Access-Control-Allow-Origin': '*' };

/**
 * workout-sessions with a scriptable save: each save takes the next reply
 * (the last one repeats). Everything else answers from the shared mock; a
 * cancel waits on `holdCancel` when one is set.
 */
class SaveStub {
  replies: Reply[] = [{ status: 200 }];
  saves = 0;
  holdCancel: Promise<void> | null = null;

  async install(page: Page) {
    await page.route('**/api/workout-sessions**', async route => {
      const body = (route.request().postDataJSON() ?? {}) as SessionBody;
      if (body.action === 'save') {
        const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
        this.saves++;
        return route.fulfill({
          status: reply.status, headers: CORS, contentType: 'application/json',
          body: reply.body ?? JSON.stringify({ ok: reply.status < 400 }),
        });
      }
      if (body.action === 'cancel' && this.holdCancel) await this.holdCancel;
      return route.fulfill({
        status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(sessionResponse(body)),
      });
    });
  }
}

/** Every toast ever shown, in order. A toast outlives the assertion that
 *  looks for it only by its 5 s auto-dismiss, so count them as they mount. */
async function recordToasts(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = seen;
    new MutationObserver(records => {
      // The container mounts with its first toast, so search each added subtree.
      for (const r of records) for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const found = n.matches('.toast') ? [n] : [...n.querySelectorAll('.toast')];
        for (const t of found) seen.push(t.textContent ?? '');
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
const toasts = (page: Page) => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
const count = async (page: Page, prefix: string) => (await toasts(page)).filter(t => t.startsWith(prefix)).length;

/** The failed saves this test stubbed are the only console errors it may
 *  leave: each one is the browser's resource error for one of `statuses`. */
function expectOnlyStubbedFailures(consoleErrors: string[], statuses: number[]) {
  const stubbed = new RegExp(`^Failed to load resource: the server responded with a status of (${statuses.join('|')})\\b`);
  expect(consoleErrors.filter(e => !stubbed.test(e)), 'console errors other than the stubbed saves').toEqual([]);
  consoleErrors.length = 0;
}

interface SaveState { consecutiveFailures: number; paused: boolean; rejected: number }
const saveState = async (page: Page) => (await apexState<{ saveState: SaveState }>(page, 'workoutSession')).saveState;

async function openTracker(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });
}

const FIELD = 'input.tracker-input--weight, input.tracker-input--reps';

/** Type into set row `row`'s first reps/weight field; the debounce sends it. */
async function edit(page: Page, row: number, value: string) {
  const input = page.locator('.tracker-set').filter({ has: page.locator(FIELD) }).nth(row).locator(FIELD).first();
  await input.click(); // commits any ghost first, so fill types onto a known value
  await input.fill(value);
}

test.beforeEach(async ({ page }) => { await recordToasts(page); });

test('a failing streak toasts once; the next streak toasts again', async ({ page, consoleErrors }) => {
  const stub = new SaveStub();
  stub.replies = [{ status: 503 }];
  await stub.install(page);
  await openTracker(page);

  await edit(page, 0, '7');
  // Three failures: the first send and two backoff retries (1 s, 2 s).
  await expect.poll(async () => (await saveState(page)).consecutiveFailures, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  expect(await count(page, 'Autosave failed'), 'one toast per streak; the bar carries the rest').toBe(1);

  stub.replies = [{ status: 200 }];
  await page.locator('.tracker-unsaved__retry').click();
  await expect.poll(async () => (await saveState(page)).consecutiveFailures, { timeout: 10000 }).toBe(0);

  stub.replies = [{ status: 503 }];
  await edit(page, 0, '8');
  await expect.poll(async () => (await saveState(page)).consecutiveFailures, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => count(page, 'Autosave failed')).toBe(2);
  expectOnlyStubbedFailures(consoleErrors, [503]);
});

test('a 401 mid-streak still pauses with its own toast', async ({ page, consoleErrors }) => {
  const stub = new SaveStub();
  stub.replies = [{ status: 503 }, { status: 401 }];
  await stub.install(page);
  await openTracker(page);

  await edit(page, 0, '7');
  await expect.poll(async () => (await saveState(page)).paused, { timeout: 15000 }).toBe(true);
  await expect.poll(() => count(page, 'Autosave paused — sign in again, then Retry')).toBe(1);
  expect(await count(page, 'Autosave failed')).toBe(1);
  expectOnlyStubbedFailures(consoleErrors, [503, 401]);
});

test("a refused batch is silent; each isolated row shows the server's message once", async ({ page, consoleErrors }) => {
  const stub = new SaveStub();
  stub.replies = [{ status: 422, body: 'Weight must be a number' }];
  await stub.install(page);
  await openTracker(page);

  // Both edits land inside one 800 ms debounce: one two-key send, refused,
  // which the queue then isolates into two single-key sends.
  await edit(page, 0, '7');
  await edit(page, 1, '9');
  await expect.poll(async () => (await saveState(page)).rejected, { timeout: 15000 }).toBe(2);
  expect(stub.saves, 'the batch, then one send per row').toBe(3);
  await expect.poll(async () => (await toasts(page)).filter(t => t.startsWith('Autosave'))).toEqual([
    'Autosave refused: Weight must be a number',
    'Autosave refused: Weight must be a number',
  ]);
  expectOnlyStubbedFailures(consoleErrors, [422]);
});

test('nothing is sent while the cancel request is out', async ({ page, consoleErrors }) => {
  const stub = new SaveStub();
  stub.replies = [{ status: 503 }];
  let release!: () => void;
  stub.holdCancel = new Promise<void>(r => { release = r; });
  await stub.install(page);
  await openTracker(page);

  await edit(page, 0, '7');
  await expect.poll(async () => (await saveState(page)).consecutiveFailures, { timeout: 10000 }).toBe(1);

  await page.locator('.tracker-cancel').click();
  await page.getByRole('button', { name: 'Discard workout' }).click();
  await expect(page.getByRole('button', { name: 'Discarding…' })).toBeVisible();

  // The 1 s and 2 s backoff retries both fall inside the held cancel. The
  // queue still runs them; the send refuses before anything leaves.
  const savesAtCancel = stub.saves;
  await expect.poll(async () => (await saveState(page)).consecutiveFailures, { timeout: 10000 }).toBeGreaterThanOrEqual(3);
  expect(stub.saves, 'no save leaves while the delete is in flight').toBe(savesAtCancel);
  expect(await count(page, 'Autosave failed')).toBe(1);

  release();
  await expect(page.locator('.tracker-set')).toHaveCount(0, { timeout: 10000 });
  expectOnlyStubbedFailures(consoleErrors, [503]);
});
