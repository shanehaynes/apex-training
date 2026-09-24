// Screenshots for help/connect-coros.md. A generator, not a test: run it by
// name (e2e/shots/README.md) and commit what it writes under
// public/help/connect-coros/.
//
//   APEX_PORT=<port> npx playwright test --project=shots-phone \
//     --project=shots-desktop e2e/shots/connect-coros.shots.ts
//
// Phone shots are the page's default. The one desktop shot is the Sync button,
// because a computer shows its label and a phone shows only the icon. Shots 02
// and 03 are COROS's own sign-in and consent pages, which the mock app cannot
// render — they are EXTERNAL placeholders in the markdown.
//
// Every COROS state here is a page.route over /api/provider-sync (which
// outranks intercept.mjs's "not configured" stub), and the synced run in shot
// 06 is a page.route over workout_events / workout_completions /
// activity_streams — the shared intercepts are never edited for a picture.

import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';

const SLUG = 'connect-coros';

type CorosStatus = 'disconnected' | 'connected' | 'expired';

// A watch run that matches a planned workout, and one that does not — the
// same shape e2e/mock/coros-sync.spec.ts scripts.
const PROPOSALS = [
  {
    activity: {
      activityId: 'a-run', sportLabel: 'Trail Run', apexType: 'cardio',
      localDate: '2026-09-06', displayTime: '6:32 AM', durationMin: 47,
      distance: '5.20 mi', avgHr: 152,
    },
    match: { eventId: 'w1-run', eventDate: '2026-09-06', title: 'Morning Run', startTime: '6:30 AM', type: 'cardio' },
  },
  {
    activity: {
      activityId: 'a-bike', sportLabel: 'Bike', apexType: 'cardio',
      localDate: '2026-09-05', displayTime: '7:00 AM', durationMin: 95,
      distance: '18.64 mi', avgHr: 138,
    },
    match: null,
  },
];

async function stubCoros(page: Page, status: CorosStatus) {
  await page.route('**/api/provider-sync', route => {
    const body = route.request().postDataJSON() as { action: string };
    if (body.action === 'status') {
      const linked = status !== 'disconnected';
      return route.fulfill({ json: {
        coros: {
          status, configured: true, autoSync: true, pendingFillCount: 0,
          lastSyncedAt: linked ? '2026-09-07T03:31:00Z' : null,
          connectedAt: linked ? '2026-09-01T12:00:00Z' : null,
        },
      } });
    }
    if (body.action === 'preview') return route.fulfill({ json: { proposals: PROPOSALS } });
    return route.fulfill({ json: { ok: true } });
  });
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

async function fulfillRest(page: Page, pattern: RegExp, rows: unknown[], single: unknown) {
  await page.route(pattern, route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify(wantsObject ? single : rows),
    });
  });
}

const RUN_ID = 'coros-shot-run';
const RUN_DATE = '2026-09-07';
const RUN_SECONDS = 47 * 60;

/** A believable heart-rate trace: warm-up ramp, two climbs, easy finish. */
function heartRate(): [number, number][] {
  const out: [number, number][] = [];
  for (let sec = 0; sec <= RUN_SECONDS; sec += 20) {
    const t = sec / RUN_SECONDS;
    const ramp = Math.min(1, t / 0.12);
    const hills = 12 * Math.exp(-(((t - 0.38) / 0.08) ** 2)) + 16 * Math.exp(-(((t - 0.7) / 0.07) ** 2));
    const cool = t > 0.9 ? -14 * ((t - 0.9) / 0.1) : 0;
    const wobble = 2.5 * Math.sin(sec / 45) + 1.5 * Math.sin(sec / 13);
    out.push([sec, Math.round(104 + 44 * ramp + hills + cool + wobble)]);
  }
  return out;
}

/** A lopsided loop with two hills, as [sec, lat, lon, elevation m]. */
function route(): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let sec = 0; sec <= RUN_SECONDS; sec += 30) {
    const a = (sec / RUN_SECONDS) * 2 * Math.PI;
    const lat = 39.99 + 0.012 * Math.sin(a) + 0.003 * Math.sin(3 * a);
    const lon = -105.27 + 0.018 * Math.cos(a) + 0.004 * Math.cos(2 * a);
    const t = sec / RUN_SECONDS;
    const ele = 1650 + 60 * Math.exp(-(((t - 0.38) / 0.1) ** 2)) + 85 * Math.exp(-(((t - 0.7) / 0.09) ** 2));
    out.push([sec, +lat.toFixed(5), +lon.toFixed(5), Math.round(ele)]);
  }
  return out;
}

/** The calendar holds one run that came in from the watch, with its metrics. */
async function stubSyncedRun(page: Page) {
  await fulfillRest(page, /\.supabase\.co\/rest\/v1\/workout_events/, [{
    id: RUN_ID, type: 'cardio', sport: 'running', title: 'Trail Run', subtitle: 'Synced from COROS',
    date: RUN_DATE, start_time: '6:32 AM', end_time: null, estimated_duration: 47, description: '',
    warmup: [], exercises: [{ id: 'coros-shot-run-ex', name: 'Trail Run', category: 'cardio', duration: '47 min' }],
    cooldown: [], difficulty: 3, location: null, cover_image_url: null, cardio_targets: null,
    climbing_targets: null, tags: [], equipment: [], source: 'coros', template_id: null,
    scoring_type: null, time_cap_minutes: null, is_recurring: false, recurrence_rule: null,
    recurring_frequency: null, recurring_days: null, recurring_end_date: null,
  }], null);
  await fulfillRest(page, /\.supabase\.co\/rest\/v1\/workout_completions/, [{ event_id: RUN_ID }], null);
  const streams = {
    provider: 'coros',
    summary: {
      sportLabel: 'Trail Run', avgHr: 152, maxHr: 171, calories: 612,
      distanceMeters: 8369, elevationGainMeters: 150, trainingLoad: 94,
    },
    streams: { hr: heartRate(), gps: route() },
  };
  await fulfillRest(page, /\.supabase\.co\/rest\/v1\/activity_streams/, [streams], streams);
}

const isPhone = (testInfo: TestInfo) => testInfo.project.name === 'shots-phone';

/**
 * Phone opens on the day view, desktop on the month grid; wait for the day's
 * workouts either way, so no shot catches an empty calendar mid-load. The
 * "Finish setting up" card is closed (local state only): it is another
 * feature's, and it would sit in every calendar shot.
 */
async function openApp(page: Page, testInfo: TestInfo) {
  await page.goto('/');
  const workout = isPhone(testInfo)
    ? page.locator('.day-view').getByRole('button', { name: /^Open / }).first()
    : page.locator('.event-chip__main').first();
  await expect(workout).toBeVisible({ timeout: 20000 });
  const nudge = page.locator('.setup-nudge__dismiss');
  if (await nudge.isVisible()) await nudge.click();
}

/** Scroll `el` to the top of its scroller, clear of the sticky sheet header. */
async function scrollToTop(el: Locator) {
  await el.evaluate(node => {
    (node as HTMLElement).style.scrollMarginTop = '84px';
    node.scrollIntoView({ block: 'start' });
  });
}

/** Profile → the COROS fold, opened and scrolled to the top of the sheet. */
async function openCorosFold(page: Page) {
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  const fold = page.locator('.profile-fold').filter({ has: page.locator('.profile-section__title', { hasText: /^COROS$/ }) });
  const toggle = fold.locator('.profile-fold__toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(fold.locator('.profile-fold__body')).toBeVisible();
  await scrollToTop(fold);
  return fold;
}

test('01 Profile → COROS, not connected', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'phone shot');
  await stubCoros(page, 'disconnected');
  await openApp(page, testInfo);
  const fold = await openCorosFold(page);
  const connect = fold.getByRole('button', { name: 'Connect COROS' });
  await expect(connect).toBeVisible();
  await helpShot(page, { slug: SLUG, n: 1, name: 'connect-coros', highlight: connect });
});

test('04 the Sync button at the top', async ({ page }, testInfo) => {
  await stubCoros(page, 'connected');
  await openApp(page, testInfo);
  const sync = page.getByTestId('nav-coros-sync');
  await expect(sync).toBeVisible();
  await expect(sync).toHaveAttribute('title', 'Sync activities from COROS');
  await helpShot(page, { slug: SLUG, n: 4, name: 'sync-button', highlight: sync });
});

test('05 a match waits: Fill it or Keep separate', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'phone shot');
  await stubCoros(page, 'connected');
  await openApp(page, testInfo);
  await page.getByTestId('nav-coros-sync').click();
  const card = page.getByTestId('sync-confirm-card');
  await expect(card).toContainText('Trail Run · 6:32 AM · 5.20 mi — fill planned “Morning Run”?');
  await expect(card.getByRole('button', { name: 'Fill it' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Keep separate' })).toBeVisible();
  await helpShot(page, { slug: SLUG, n: 5, name: 'fill-or-keep', highlight: card });
});

test('06 a synced run with its heart-rate chart', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'phone shot');
  await stubCoros(page, 'connected');
  await stubSyncedRun(page);
  await openApp(page, testInfo);
  await page.locator('.day-view').getByRole('button', { name: /^Open .*Trail Run/ }).first().click();
  const metrics = page.getByTestId('sync-metrics');
  await expect(metrics).toContainText('Synced from COROS');
  await expect(metrics).toContainText('152/171 bpm');
  const chart = page.locator('.stream-chart').filter({ hasText: 'Heart rate' });
  await expect(chart).toBeVisible();
  await helpShot(page, { slug: SLUG, n: 6, name: 'synced-run', highlight: metrics });
});

test('07 connected, with the nightly checkbox and Disconnect COROS', async ({ page }, testInfo) => {
  test.skip(!isPhone(testInfo), 'phone shot');
  await stubCoros(page, 'connected');
  await openApp(page, testInfo);
  const fold = await openCorosFold(page);
  await expect(fold.locator('.profile-fold__status')).toHaveText('Connected');
  const nightly = fold.locator('.coros-auto-sync');
  await expect(nightly.getByRole('checkbox')).toBeChecked();
  await expect(fold.getByRole('button', { name: 'Disconnect COROS' })).toBeVisible();
  await helpShot(page, { slug: SLUG, n: 7, name: 'connected', highlight: nightly });
});
