import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// The keyless weekly review: the server answers 200 with no document and
// the computed stats, and the overlay renders the numbers alone with one
// line on what a key adds. With a document, the same numbers sit beside it.
// The mock clock is Mon 2026-09-07, so the reviewed week is Sep 7–13.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

const STATS = {
  week: { start: '2026-09-07', end: '2026-09-13' },
  asOf: '2026-09-07',
  plan: {
    planned: 5, completed: 3, minutesPlanned: 310, minutesDone: 205,
    misses: [{ eventId: 'w12-wed-stretch', title: 'Nightly Stretch — Spine & Hip', date: '2026-09-09' }],
  },
  prs: [{ exerciseName: 'Back Squat', kind: 'reps', date: '2026-09-07', detail: '12 reps, up from 10 on Aug 31' }],
  weightUnit: 'lb',
  physiology: {
    load: { source: 'cardioMinutes', acute7d: 120, chronicWeeklyAvg28d: 100, ratio: 1.2, historyDays: 35 },
    hrv: null,
    zoneMinutes: null,
    tonnageByWeek: [
      { weekStart: '2026-08-10', tonnageLb: null }, { weekStart: '2026-08-17', tonnageLb: 8000 },
      { weekStart: '2026-08-24', tonnageLb: 9000 }, { weekStart: '2026-08-31', tonnageLb: 9500 },
      { weekStart: '2026-09-07', tonnageLb: 3000 },
    ],
  },
};

const KEYLESS = { document: null, model: null, stats: STATS, warnings: [], generatedAt: '2026-09-07T08:00:00Z' };

const DOCUMENT = {
  week: { start: '2026-09-07', end: '2026-09-13' },
  planVsDone: STATS.plan,
  physiology: { summary: 'Load ratio 1.2.', flags: [] },
  doctrine: null,
  memoryProposals: [],
  nextWeek: [],
  headline: 'A steady week.',
};

function stubReview(page: Page, body: unknown) {
  return page.route('**/api/weekly-review', route => route.fulfill({
    status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
  }));
}

test('without a key the review shows the computed numbers and a line on what a key adds', async ({ page }) => {
  await stubReview(page, KEYLESS);
  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();

  const view = page.getByTestId('weekly-review-numbers-only');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('weekly-review-model')).toHaveText('numbers only');
  await expect(page.getByTestId('weekly-review-headline')).toHaveCount(0);

  const plan = page.getByTestId('weekly-review-plan');
  await expect(plan.locator('tbody tr').nth(0)).toContainText('60%');
  await expect(plan.locator('.weekly-review__miss-title')).toHaveText('Nightly Stretch — Spine & Hip');

  await expect(page.getByTestId('weekly-review-pr')).toContainText('Back Squat');
  await expect(page.getByTestId('weekly-review-acwr')).toHaveText('1.20');
  await expect(page.getByTestId('weekly-review-tonnage-week')).toHaveCount(5);
  await expect(page.getByTestId('weekly-review-key-hint')).toContainText('Add your Anthropic key');
  await expect(page.getByTestId('weekly-review-key-hint').getByRole('button', { name: 'Add key' })).toBeVisible();
  await shot(page, 'weekly-review-keyless');
});

test('with a document the same numbers render beside it', async ({ page }) => {
  await stubReview(page, { ...KEYLESS, document: DOCUMENT, model: { id: 'claude-opus-5-5', label: 'Opus 5.5', badge: 'claude opus 5.5' } });
  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();

  await expect(page.getByTestId('weekly-review-headline')).toHaveText('A steady week.');
  await expect(page.getByTestId('weekly-review-document').getByTestId('weekly-review-numbers')).toBeVisible();
  await expect(page.getByTestId('weekly-review-acwr')).toHaveText('1.20');
  await expect(page.getByTestId('weekly-review-key-hint')).toHaveCount(0);
});

test('saving a key in Profile while the review is open asks again and the document replaces the numbers', async ({ page }) => {
  let hasKey = false;
  await page.route('**/api/profile', route => {
    const method = route.request().method();
    if (method === 'PATCH') hasKey = true;
    else if (method !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        hasAnthropicKey: hasKey,
        anthropicKeyLast4: hasKey ? '1234' : null,
        termsAccepted: { termsVersion: 'terms-v1', privacyVersion: 'privacy-v1', acceptedAt: '2026-08-29T00:00:00.000Z' },
        termsCurrent: true,
      }),
    });
  });
  const posted: unknown[] = [];
  await page.route('**/api/weekly-review', route => {
    posted.push(route.request().postDataJSON());
    const body = hasKey
      ? { ...KEYLESS, document: DOCUMENT, model: { id: 'claude-opus-5-5', label: 'Opus 5.5', badge: 'claude opus 5.5' } }
      : KEYLESS;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  });

  await gotoCalendar(page);
  await page.getByTestId('nav-weekly-review').click();
  await expect(page.getByTestId('weekly-review-numbers-only')).toBeVisible();
  expect(posted).toHaveLength(1);

  await page.getByTestId('weekly-review-key-hint').getByRole('button', { name: 'Add key' }).click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await page.getByLabel('Anthropic key').fill('sk-ant-test-key-1234');
  await page.getByRole('button', { name: 'Save key' }).click();

  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]).toEqual({ today: '2026-09-07', week: '2026-09-07' });
  await expect(page.getByTestId('weekly-review-headline')).toHaveText('A steady week.');
  await expect(page.getByTestId('weekly-review-numbers-only')).toHaveCount(0);
});
