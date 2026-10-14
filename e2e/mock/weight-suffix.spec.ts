import { createRequire } from 'node:module';
import type { Page, Request } from '@playwright/test';
import { test, expect, gotoCalendar, shot } from '../lib/fixtures';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { sessionResponse } from '../lib/intercept.mjs';
// @ts-expect-error plain-JS module shared with scripts/drive.mjs
import { driverProfile } from '../lib/session.mjs';

// A committed bare weight is saved with the unit it was typed in, so a
// later unit switch — which re-declares what bare numbers mean — never
// reinterprets it. Under a kg profile: a typed "100" saves as "100 kg", a
// tapped ghost "100" commits as "100 kg", and "BW+10" and "185 lb" save as
// typed. A profile whose unit is not known (the column absent) suffixes
// nothing: its lb default is a guess.

const seed = createRequire(import.meta.url)('../../src/data/schedule.json') as {
  events: Array<{ id: string } & Record<string, unknown>>;
};

// One lift over the seed's Pull Day. The shared stub ghosts rows 1 and 2
// from a fabricated last performance (100 × 8, then 105 × 8); row 3 has none.
const EVENT = {
  ...seed.events.find(e => e.id === 'w1-sat-weights')!,
  warmup: [],
  cooldown: [],
  exercises: [
    { id: 'ws-1', name: 'Bench Press', category: 'strength', sets: 3, reps: '5', weight: '185 lbs' },
  ],
};

interface SetRowWire { set_number: number; actual_weight: string | null }
interface SessionBody { action: string; setLogs?: SetRowWire[] }

const json = (body: unknown) => ({
  status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body),
});
const setLogsOf = (req: Request): SetRowWire[] => (req.postDataJSON() as SessionBody)?.setLogs ?? [];
const isSave = (req: Request) =>
  req.url().includes('/api/workout-sessions') && (req.postDataJSON() as SessionBody)?.action === 'save';

/** Every set row the tracker sent, in order. */
async function installSessionStub(page: Page): Promise<SetRowWire[]> {
  const sent: SetRowWire[] = [];
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as SessionBody;
    if (body.action === 'save') {
      sent.push(...(body.setLogs ?? []));
      return route.fulfill(json({ ok: true }));
    }
    return route.fulfill(json(sessionResponse(body, { event: EVENT })));
  });
  return sent;
}

/** The own-profile read, with the phase55 columns this spec needs. Outranks the context stub. */
async function stubProfile(page: Page, columns: Record<string, unknown>) {
  const profile = { ...driverProfile(), ...columns };
  await page.route('**/rest/v1/profiles*', route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill(json(wantsObject ? profile : [profile]));
  });
}

async function openTracker(page: Page) {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-exercise', { hasText: 'Bench Press' })).toBeVisible({ timeout: 15000 });
}

const weight = (page: Page, n: number) =>
  page.locator('.tracker-set:not(.tracker-set--head)').nth(n - 1).locator('input.tracker-input--weight');

/** Type into a weight field and commit it with Enter; resolves with the save that carried `saved` for that set. */
async function commitWeight(page: Page, n: number, typed: string, saved: string) {
  const field = weight(page, n);
  const request = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.set_number === n && r.actual_weight === saved));
  await field.click();
  await field.fill(typed);
  await field.press('Enter');
  await expect(field).toHaveValue(saved);
  await request;
}

test('under a kg profile a bare weight is saved with its unit; BW forms and suffixed text are saved as typed', async ({ page }) => {
  await stubProfile(page, { weight_unit: 'kg', body_weight_lb: 180 });
  const sent = await installSessionStub(page);
  await openTracker(page);

  // The planned label stays raw (R1.8); only what is committed gains a unit.
  await expect(page.locator('.tracker-set:not(.tracker-set--head) .tracker-set__planned').first()).toHaveText('185 lbs × 5');

  // A ghost tap is a commit: last time's bare 100 is committed as 100 kg.
  const ghostSaved = page.waitForRequest(req =>
    isSave(req) && setLogsOf(req).some(r => r.set_number === 1 && r.actual_weight === '100 kg'));
  await weight(page, 1).click();
  await expect(weight(page, 1)).toHaveValue('100 kg');
  await ghostSaved;

  // Typed: a bare 100 commits (Enter) as 100 kg.
  await commitWeight(page, 2, '100', '100 kg');
  await shot(page, 'weight-suffix-kg');

  // Never rewritten: a body-weight form, and text that already names a unit.
  await commitWeight(page, 3, 'BW+10', 'BW+10');
  await commitWeight(page, 1, '185 lb', '185 lb');

  // Nothing bare ever left the tracker.
  expect(sent.map(r => r.actual_weight).filter(w => w && /^\s*\d+(?:[.,]\d+)?\s*$/.test(w))).toEqual([]);
});

test('with no known unit on the profile, a bare weight is saved as typed', async ({ page }) => {
  // The fixtures' driver profile predates phase55: no weight_unit column.
  await installSessionStub(page);
  await openTracker(page);
  await commitWeight(page, 3, '100', '100');
});
