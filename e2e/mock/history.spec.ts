import type { Page } from '@playwright/test';
import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS helper shared with the intercept
import { mockSession, sessionResponse } from '../lib/intercept.mjs';

// The History overlay over a scripted list_sessions: paging, the title
// search and type chips (sent as tool args, applied by the stub), the empty
// state, and opening a session six months older than anything on the
// calendar in the tracker's view mode. Fake now is 2026-09-07; the seed
// schedule starts 2026-06-22, so the March session is one the schedule
// context cannot hold — the stub-event path.

interface Row {
  id: string; eventId: string; eventDate: string; title: string; type: string; sport: string | null;
  tags: string[]; startedAt: string; finishedAt: string | null; durationSeconds: number | null;
  hasSummary: boolean; score: null;
}

const row = (id: string, eventId: string, eventDate: string, title: string, type: string, over: Partial<Row> = {}): Row => ({
  id, eventId, eventDate, title, type, sport: null, tags: [],
  startedAt: `${eventDate}T07:00:00.000Z`, finishedAt: `${eventDate}T07:25:00.000Z`, durationSeconds: 1500,
  hasSummary: false, score: null, ...over,
});

const SESSIONS: Row[] = [
  row('sess-recent', 'w1-mon-morning__2026-08-31', '2026-08-31', 'Morning Movement Routine', 'morning-routine', { hasSummary: true }),
  row('sess-march', 'w1-mon-stretch', '2026-03-02', 'Nightly Stretch — Upper', 'stretching', { durationSeconds: 1200 }),
  row('sess-feb', 'w1-tue-stretch', '2026-02-24', 'Nightly Stretch — Lower', 'stretching'),
];

interface QueryArgs { cursor?: string; limit?: number; q?: string; type?: string }

/** list_sessions over the fixture rows: q and type applied, two rows a page. */
async function stubHistory(page: Page, calls: QueryArgs[]) {
  await page.route('**/api/query', async route => {
    const body = (route.request().postDataJSON() ?? {}) as { tool?: string; args?: QueryArgs };
    if (body.tool !== 'list_sessions') return route.fulfill({ status: 400, body: 'unknown tool' });
    const args = body.args ?? {};
    calls.push(args);
    const matched = SESSIONS.filter(s =>
      (!args.q || s.title.toLowerCase().includes(args.q.toLowerCase())) &&
      (!args.type || s.type === args.type));
    const start = args.cursor ? Number(args.cursor) : 0;
    const sessions = matched.slice(start, start + 2);
    const nextCursor = start + 2 < matched.length ? String(start + 2) : null;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ tool: 'list_sessions', result: { sessions, nextCursor } }),
    });
  });
  // Every opened session reports finished, so the tracker renders view mode.
  await page.route('**/api/workout-sessions**', async route => {
    const body = (route.request().postDataJSON() ?? {}) as { eventId?: string; eventDate?: string };
    const session = mockSession({
      id: `session-${body.eventId}`, event_id: body.eventId, event_date: body.eventDate,
      started_at: `${body.eventDate}T07:00:00.000Z`, finished_at: `${body.eventDate}T07:20:00.000Z`,
      total_duration_seconds: 1200,
    });
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(sessionResponse(body, { session })),
    });
  });
}

test('history lists, pages, searches and filters sessions, and opens one six months old', async ({ page }) => {
  const calls: QueryArgs[] = [];
  await stubHistory(page, calls);
  await gotoCalendar(page);

  await page.getByTestId('nav-history').click();
  await expect(page.getByTestId('history-view')).toBeVisible();
  expect((await apexState<{ historyOpen: boolean }>(page, 'calendar')).historyOpen).toBe(true);

  const rows = page.locator('.history-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Morning Movement Routine');
  await expect(rows.nth(0)).toContainText('Summary');
  await expect(rows.nth(1)).toContainText('Mon, Mar 2, 2026');
  await shot(page, 'history-list');

  // Load more appends the next page under the same filters.
  await page.locator('.history-more').click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('Nightly Stretch — Lower');
  await expect(page.locator('.history-more')).toHaveCount(0);
  expect(calls.at(-1)).toMatchObject({ cursor: '2' });

  // The search is a title substring sent as `q`, debounced.
  await page.locator('.history-search__input').fill('lower');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Nightly Stretch — Lower');
  expect(calls.at(-1)).toMatchObject({ q: 'lower' });
  expect(calls.at(-1)).not.toHaveProperty('cursor');

  await page.locator('.history-search__input').fill('nothing like this');
  await expect(page.locator('.history-empty')).toContainText('No sessions match');
  await shot(page, 'history-empty');
  await page.locator('.history-search__input').fill('');
  await expect(rows).toHaveCount(2);

  // A type chip is sent as `type`.
  await page.locator('.history-filter', { hasText: 'Morning Routine' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Morning Movement Routine');
  expect(calls.at(-1)).toMatchObject({ type: 'morning-routine' });
  await page.locator('.history-filter', { hasText: 'All' }).click();
  await expect(rows).toHaveCount(2);

  // The March session predates the seed schedule: it opens from the row alone.
  await rows.nth(1).click();
  await expect(page.locator('.tracker')).toBeVisible();
  await expect(page.locator('.tracker-header__title')).toHaveText('Nightly Stretch — Upper');
  await expect(page.locator('.tracker-header__date')).toHaveText('Monday, Mar 2');
  await expect(page.locator('.tracker-header__done-badge')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.tracker-set').first()).toBeVisible();
  expect((await apexState<{ trackingEventId: string }>(page, 'calendar')).trackingEventId).toBe('w1-mon-stretch');
  await shot(page, 'history-open-session');

  // Back lands on the list, not the calendar; the close puts the calendar back.
  await page.locator('.tracker-header__back').click();
  await expect(page.locator('.tracker')).toHaveCount(0);
  await expect(page.getByTestId('history-view')).toBeVisible();
  await page.locator('.history-close').click();
  await expect(page.getByTestId('history-view')).toHaveCount(0);
  expect((await apexState<{ historyOpen: boolean }>(page, 'calendar')).historyOpen).toBe(false);
});

test('history shows its empty state when nothing was ever tracked', async ({ page }) => {
  await page.route('**/api/query', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tool: 'list_sessions', result: { sessions: [], nextCursor: null } }),
  }));
  await gotoCalendar(page);
  await page.getByTestId('nav-history').click();
  await expect(page.locator('.history-empty')).toContainText('No tracked sessions yet');
  await expect(page.locator('.history-more')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the bottom nav carries the History entry and the top nav does not', async ({ page }) => {
    const calls: QueryArgs[] = [];
    await stubHistory(page, calls);
    await page.goto('/');
    await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });
    await expect(page.getByTestId('nav-history')).toBeHidden();
    // The Coach tab keeps its index: specs address it as the second tab.
    await expect(page.locator('.mobile-nav__tab').nth(1)).toContainText('Coach');

    await page.getByTestId('mobile-nav-history').click();
    await expect(page.getByTestId('history-view')).toBeVisible();
    await expect(page.locator('.history-row')).toHaveCount(2);
    await expect(page.getByTestId('mobile-nav-history')).toHaveClass(/mobile-nav__tab--active/);
    await shot(page, 'history-phone');
  });
});
