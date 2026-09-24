import type { Page } from '@playwright/test';
import { test, expect, gotoCalendar } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';
import { TIPS } from '../../src/lib/onboarding/tips/index';

// The three COROS tips (docs/onboarding/workstreams/O15-coros.md), each at its
// trigger in src/components/sync/ProviderSyncControls.tsx, and none of them on
// a deployment where COROS is not configured. TipHost shows one tip per page
// load, so every tip gets its own test.

test.use({ tips: 'on' });

const PROPOSALS = [
  {
    activity: {
      activityId: 'a-run', sportLabel: 'Trail Run', apexType: 'cardio',
      localDate: '2026-09-06', displayTime: '6:32 AM', durationMin: 47,
      distance: '5.20 mi', avgHr: 152,
    },
    match: { eventId: 'w1-run', eventDate: '2026-09-06', title: 'Morning Run', startTime: '6:30 AM', type: 'cardio' },
  },
];

type CorosStatus = 'disconnected' | 'connected' | 'expired';

/**
 * Script /api/provider-sync (outranks intercept.mjs's "not configured" stub).
 * Returns a setter for the status later loads should see.
 */
async function stubProviderSync(page: Page, initial: CorosStatus, configured = true) {
  let status = initial;
  await page.route('**/api/provider-sync', route => {
    const body = route.request().postDataJSON() as { action: string };
    if (body.action === 'status') {
      return route.fulfill({ json: {
        coros: {
          status, configured, autoSync: true, pendingFillCount: 0,
          lastSyncedAt: null, connectedAt: status === 'disconnected' ? null : '2026-09-01T00:00:00Z',
        },
      } });
    }
    if (body.action === 'preview') return route.fulfill({ json: { proposals: PROPOSALS } });
    if (body.action === 'apply') return route.fulfill({ json: { created: 0, filled: 1, errors: [] } });
    return route.fulfill({ json: { ok: true } });
  });
  return (next: CorosStatus) => { status = next; };
}

const COROS_TIP_IDS = ['coros-connected', 'coros-fill-queue', 'coros-expired'];

/**
 * Every tip but `unseen` already seen, so the one under test cannot lose the
 * one-per-load slot to another feature's tip once the lanes combine.
 */
async function onlyUnseen(page: Page, unseen: string[]) {
  const seen = Object.fromEntries(TIPS.filter(t => !unseen.includes(t.id)).map(t => [t.id, '2026-09-01T00:00:00Z']));
  const row = { ...driverProfile(), tips_seen: seen };
  await page.route(/\.supabase\.co\/rest\/v1\/profiles/, route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
      body: JSON.stringify(wantsObject ? row : [row]),
    });
  });
}

/** Longer than TipHost's 600 ms settle, so "no tip" means none is coming. */
async function settle(page: Page) {
  await page.waitForTimeout(1500);
}

test('the fill queue card brings the Fill it / Keep separate tip', async ({ page }) => {
  await stubProviderSync(page, 'connected');
  await onlyUnseen(page, ['coros-fill-queue']);
  await gotoCalendar(page);

  // Connected alone offers nothing: the card is the trigger.
  await settle(page);
  await expect(page.locator('.tip')).toHaveCount(0);

  await page.getByTestId('nav-coros-sync').click();
  await expect(page.getByTestId('sync-confirm-card')).toBeVisible();

  const tip = page.locator('.tip[data-tip-id="coros-fill-queue"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Fill it');
  await expect(tip).toContainText('Keep separate');
  await expect(tip.locator('.tip__link')).toHaveAttribute('href', '/help/connect-coros');

  await tip.locator('.tip__ok').click();
  await expect(tip).toHaveCount(0);
  // The card it explained is still there to answer.
  await expect(page.getByTestId('sync-confirm-card').getByRole('button', { name: 'Fill it' })).toBeVisible();
});

test('an expired link brings the Reconnect tip', async ({ page }) => {
  await stubProviderSync(page, 'expired');
  await onlyUnseen(page, ['coros-expired']);
  await gotoCalendar(page);

  await expect(page.getByTestId('nav-coros-sync')).toContainText('Reconnect');
  const tip = page.locator('.tip[data-tip-id="coros-expired"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Reconnect');
  await expect(tip.locator('.tip__link')).toHaveAttribute('href', '/help/connect-coros');
});

test('the COROS return toasts first; the connected tip comes on the next load', async ({ page }) => {
  await stubProviderSync(page, 'connected');
  await onlyUnseen(page, ['coros-connected']);

  await page.goto('/?connected=coros');
  await expect(page.getByText('COROS connected — press Sync to grab activities')).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(url => !url.search.includes('connected'));
  await settle(page);
  await expect(page.locator('.tip'), 'never over the return toast').toHaveCount(0);

  await gotoCalendar(page);
  const tip = page.locator('.tip[data-tip-id="coros-connected"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Sync');
  await expect(tip.locator('.tip__link')).toHaveAttribute('href', '/help/connect-coros');
});

test('connected without ever coming back from COROS here offers no connected tip', async ({ page }) => {
  await stubProviderSync(page, 'connected');
  await onlyUnseen(page, ['coros-connected']);
  await gotoCalendar(page);
  await expect(page.getByTestId('nav-coros-sync')).toBeVisible();
  await settle(page);
  await expect(page.locator('.tip')).toHaveCount(0);
});

test('no COROS tip on a deployment without COROS', async ({ page }) => {
  test.setTimeout(90_000); // four loads, each waited past the settle
  // Each load below would offer a COROS tip on a configured deployment:
  // back from COROS, then connected after that return, then expired.
  const setStatus = await stubProviderSync(page, 'connected', false);
  await onlyUnseen(page, COROS_TIP_IDS);

  await page.goto('/?connected=coros');
  await expect(page.getByText('COROS connected — press Sync to grab activities')).toBeVisible({ timeout: 20000 });
  await settle(page);
  await expect(page.locator('.tip')).toHaveCount(0);

  await gotoCalendar(page);
  await expect(page.getByTestId('nav-coros-sync')).toHaveCount(0);
  await settle(page);
  await expect(page.locator('.tip')).toHaveCount(0);

  setStatus('expired');
  await gotoCalendar(page);
  await settle(page);
  await expect(page.locator('.tip')).toHaveCount(0);

  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await settle(page);
  await expect(page.locator('.tip')).toHaveCount(0);
});
