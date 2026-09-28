import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { isExpectedConsoleError } from '../lib/intercept.mjs';

// The weekly review as a document (lane D03): open it from the calendar's
// toolbar, see a rendered document from a stubbed /api/weekly-review, accept
// one next-week item and prove the confirm executor (POST /api/coach-tool)
// received the exact tool input — then the card greys out. The model call
// itself never runs here: the stub IS the response.
//
// The mock clock is Mon 2026-09-07, so the reviewed week is Sep 7–13 and the
// next-week update names an occurrence of a seeded recurring series in the
// week of Sep 14 (stuart-mon-climbing-arc, Mondays, 60 min).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

const DOCUMENT = {
  week: { start: '2026-09-07', end: '2026-09-13' },
  planVsDone: {
    planned: 5, completed: 3, minutesPlanned: 310, minutesDone: 205,
    misses: [{ eventId: 'w12-wed-stretch', title: 'Nightly Stretch — Spine & Hip', date: '2026-09-09', why: 'Late night after the long climb.' }],
  },
  physiology: { summary: 'Load ratio 1.2 against the four-week average; HRV flat.', flags: ['No strength sets logged'] },
  doctrine: {
    topic: 'recovery',
    line: 'Prefer the smaller session done to the larger session skipped, in every phase.',
    verdict: 'drifting',
    note: 'The stretch was skipped rather than shortened.',
  },
  memoryProposals: [{ kind: 'preference', content: 'Prefers to stretch before 9 PM', why: 'The late slots were the ones missed.' }],
  nextWeek: [
    { tool: 'update_event', input: { event_id: 'stuart-mon-climbing-arc__2026-09-14', event_title: 'Climbing — ARC Training', changes: { estimated_duration: 45 } }, why: 'Ease into the week after a missed stretch.' },
    { tool: 'create_event', input: { type: 'cardio', title: 'Easy run', date: '2026-09-16', estimated_duration: 40, start_time: '6:30 AM' }, why: 'One easy aerobic session mid-week.' },
  ],
  headline: 'You climbed well and let the stretches slide.',
};

const RESPONSE = {
  document: DOCUMENT,
  model: { id: 'claude-opus-5-5', label: 'Opus 5.5', badge: 'claude opus 5.5' },
  warnings: [],
  generatedAt: '2026-09-07T08:00:00Z',
};

function stubReview(page: Page, body: unknown = RESPONSE, status = 200) {
  const posted: unknown[] = [];
  page.route('**/api/weekly-review', route => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({
      status,
      contentType: status === 200 ? 'application/json' : 'text/plain',
      headers: CORS,
      body: status === 200 ? JSON.stringify(body) : String(body),
    });
  });
  return posted;
}

/** Every POST the page sends to the confirm executor. */
function recordToolCalls(page: Page): Array<{ name: string; input: unknown; today: string }> {
  const calls: Array<{ name: string; input: unknown; today: string }> = [];
  page.on('request', (req: Request) => {
    if (req.method() === 'POST' && req.url().includes('/api/coach-tool')) calls.push(req.postDataJSON());
  });
  return calls;
}

test('opens from the calendar toolbar and renders the document the server returned', async ({ page }) => {
  const posted = stubReview(page);
  await gotoCalendar(page);

  await page.getByTestId('nav-weekly-review').click();
  const view = page.getByTestId('weekly-review-view');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('weekly-review-week')).toHaveText('Sep 7 – 13, 2026');

  await expect(page.getByTestId('weekly-review-headline')).toHaveText(DOCUMENT.headline);
  await expect(page.getByTestId('weekly-review-model')).toHaveText('claude opus 5.5');
  // The request carried the fake clock's day and the week it opens on.
  expect(posted).toEqual([{ today: '2026-09-07', week: '2026-09-07' }]);

  const plan = page.getByTestId('weekly-review-plan');
  await expect(plan.locator('tbody tr').nth(0)).toContainText('5');
  await expect(plan.locator('tbody tr').nth(0)).toContainText('60%');
  await expect(plan.locator('.weekly-review__miss-title')).toHaveText('Nightly Stretch — Spine & Hip');
  await expect(plan.locator('.weekly-review__miss-why')).toHaveText('Late night after the long climb.');

  await expect(page.getByTestId('weekly-review-physiology').locator('.weekly-review__flag')).toHaveText(['No strength sets logged']);
  const doctrine = page.getByTestId('weekly-review-doctrine');
  await expect(doctrine.locator('.weekly-review__doctrine-topic')).toHaveText('Recovery, monitoring and load management');
  await expect(doctrine.locator('.weekly-review__quote')).toContainText('Prefer the smaller session done');
  await expect(doctrine.locator('.weekly-review__verdict')).toHaveText('Drifting');

  await expect(page.getByTestId('memory-proposal')).toHaveCount(1);
  const items = page.getByTestId('next-week-item');
  await expect(items).toHaveCount(2);
  // The update resolves against the seeded series: the confirm card's own diff.
  const update = items.nth(0);
  await expect(update).toHaveAttribute('data-tool', 'update_event');
  await expect(update.locator('.weekly-review__card-title')).toContainText('Update: Climbing — ARC Training');
  await expect(update.locator('.confirm-preview__before')).toHaveText(['60 min']);
  await expect(update.locator('.confirm-preview__after')).toHaveText(['45 min']);
  await expect(items.nth(1).locator('.confirm-preview__line')).toContainText('Wed Sep 16 · 6:30 AM · 40 min · cardio');
  await shot(page, 'weekly-review');
});

test('accepting a next-week item posts the exact tool input to the confirm executor and greys the card out', async ({ page }) => {
  stubReview(page);
  const calls = recordToolCalls(page);
  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();

  const items = page.getByTestId('next-week-item');
  await expect(items).toHaveCount(2);
  const update = items.nth(0);
  await update.getByRole('button', { name: 'Accept' }).click();

  await expect(update.locator('.weekly-review__accept')).toHaveText(/Accepted/);
  await expect(update.locator('.weekly-review__accept')).toBeDisabled();
  await expect(update).toHaveClass(/weekly-review__card--done/);
  // The other card is untouched.
  await expect(items.nth(1).getByRole('button', { name: 'Accept' })).toBeEnabled();

  expect(calls).toEqual([{
    name: 'update_event',
    input: DOCUMENT.nextWeek[0].input,
    today: '2026-09-07',
  }]);
});

test('accepting a memory proposal posts the fact to the notebook\'s door', async ({ page }) => {
  stubReview(page);
  const memoryPosts: unknown[] = [];
  page.on('request', (req: Request) => {
    if (req.method() === 'POST' && req.url().includes('/api/coach-memory')) memoryPosts.push(req.postDataJSON());
  });
  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();

  const card = page.getByTestId('memory-proposal');
  await card.getByRole('button', { name: 'Remember' }).click();
  await expect(card.locator('.weekly-review__accept')).toHaveText(/Remembered/);
  expect(memoryPosts).toEqual([{ kind: 'preference', content: 'Prefers to stretch before 9 PM' }]);
});

// Chromium logs every non-2xx resource load as a console error, and the
// shared fixture fails a test on any it does not expect. The error-state
// test stubs the review route with the statuses the UI must handle, so it
// skips exactly those loads — every other console error still fails it. An
// override cannot restate `auto`, so the test names the fixture to run it.
const errorStates = test.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const url = msg.location()?.url ?? '';
      if (url.includes('/api/weekly-review') && /status of 4\d\d/.test(msg.text())) return;
      if (isExpectedConsoleError(msg)) return;
      errors.push(msg.text());
    });
    await provide(errors);
    expect.soft(errors, 'no console errors during the test').toEqual([]);
  },
});

errorStates('a 402 turns into the add-your-key state, a 422 into the server\'s reason', async ({ page, consoleErrors }) => {
  expect(consoleErrors).toEqual([]);
  stubReview(page, 'anthropic-key-missing', 402);
  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();
  await expect(page.getByTestId('weekly-review-no-key')).toBeVisible();
  await expect(page.getByTestId('weekly-review-no-key')).toContainText('Add one in Profile');

  await page.unroute('**/api/weekly-review');
  stubReview(page, 'The coach did not return a review document: not valid JSON', 422);
  await page.getByTestId('weekly-review-regenerate').click();
  await expect(page.getByTestId('weekly-review-error')).toContainText('did not return a review document');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the toolbar entry floats in the day header and opens the same document', async ({ page }) => {
    stubReview(page);
    await page.goto('/');
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
    // Above the Today badge, never over it: the badge stays tappable.
    const btn = page.getByTestId('nav-weekly-review');
    const btnBox = await btn.boundingBox();
    const badgeBox = await page.locator('.day-view__today-badge').boundingBox();
    expect(btnBox!.y + btnBox!.height).toBeLessThanOrEqual(badgeBox!.y);
    await btn.click();
    await expect(page.getByTestId('weekly-review-headline')).toHaveText(DOCUMENT.headline);
    await expect(page.getByTestId('next-week-item')).toHaveCount(2);
    await shot(page, 'weekly-review-phone');
  });
});

test('the previous-week arrow regenerates for that week', async ({ page }) => {
  const posted = stubReview(page);
  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();
  await expect(page.getByTestId('weekly-review-document')).toBeVisible();

  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.getByTestId('weekly-review-week')).toHaveText('Aug 31 – Sep 6, 2026');
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]).toEqual({ today: '2026-09-07', week: '2026-08-31' });
  // Never past this week: the forward arrow is disabled at the current week.
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.getByRole('button', { name: 'Next week' })).toBeDisabled();
});
