// Live project: training blocks against the REAL stack — GoTrue sign-in,
// RLS-scoped reads of training_blocks/objectives, /api/blocks writes
// landing in Postgres, and the DB exclusion constraint surfacing as a 409.
//
// Prereqs: supabase start && npm run db:reset-local
// Run:     npm run e2e:live

import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../scripts/lib/localEnv.mjs';
import { buildChatContext } from '../../api/_lib/coach/context';

const env = localSupabaseEnv();
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

// Monday inside the block seeded below, so "this week" renders.
const FAKE_NOW = '2026-08-03T08:00:00';

const BLOCK = {
  name: 'Fall Aerobic Foundation',
  intent: 'Build sustained aerobic capacity with weekly vert.',
  phase: 'base',
  start_date: '2026-07-06',
  end_date_exclusive: '2026-08-31',
  weekly_targets: {
    cardioMinutes: 300,
    vert: { value: 6000, unit: 'ft' },
    strengthSessions: 2,
    climbingSessions: 2,
  },
};

// Deliberately uneven so attainment is never a flat 100%.
const COMPLETIONS: Array<[string, string, number]> = [
  ['2026-07-07', 'cardio', 150], ['2026-07-09', 'cardio', 180],
  ['2026-07-11', 'weights', 60], ['2026-07-12', 'climbing', 120],
  ['2026-07-14', 'cardio', 120], ['2026-07-16', 'cardio', 90],
  ['2026-07-21', 'cardio', 260], ['2026-07-23', 'cardio', 95],
  ['2026-07-28', 'cardio', 140], ['2026-07-30', 'cardio', 160],
];

// One metric entry among feet, to exercise the unmatched-unit disclosure.
const CARDIO_LOGS: Array<[string, string, string]> = [
  ['2026-07-07', '6 mi', '2200 ft'], ['2026-07-09', '8 mi', '3100 ft'],
  ['2026-07-14', '5 mi', '1800 ft'], ['2026-07-16', '4 mi', '1200 ft'],
  ['2026-07-21', '11 mi', '4800 ft'], ['2026-07-23', '4 mi', '1400 ft'],
  ['2026-07-28', '6 mi', '2400 ft'], ['2026-07-30', '7 mi', '900 m'],
];

async function userId(email: string): Promise<string> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const user = data.users.find(u => u.email === email);
  if (!user) throw new Error(`missing fixture user ${email}`);
  return user.id;
}

async function signIn(page: Page, email: string) {
  await page.addInitScript(v => {
    (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
  }, FAKE_NOW);
  await page.goto('/');
  await expect(page.locator('.auth-card')).toBeVisible({ timeout: 20000 });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill('apex-agent-password');
  await page.locator('.auth-submit').click();
}

test.beforeEach(async () => {
  const uid = await userId('agent@apex.local');
  await admin.from('training_blocks').delete().eq('user_id', uid);
  await admin.from('objectives').delete().eq('user_id', uid);
  await admin.from('workout_completions').delete().like('event_id', 'blkspec-%');
  await admin.from('workout_cardio_logs').delete().like('event_id', 'blkspec-%');

  const { data: objective } = await admin
    .from('objectives')
    .insert({ user_id: uid, name: 'Liberty Ridge', target_date: '2027-06-15', discipline: 'alpine' })
    .select('id')
    .single();

  await admin.from('training_blocks').insert({ ...BLOCK, user_id: uid, objective_id: objective!.id });

  await admin.from('workout_completions').insert(
    COMPLETIONS.map(([date, type, minutes]) => ({
      user_id: uid, event_id: `blkspec-${date}-${type}`, event_date: date,
      event_type: type, event_title: `${type} session`, duration_minutes: minutes,
      is_completed: true, completed_at: `${date}T12:00:00Z`, updated_at: new Date().toISOString(),
    })),
  );

  await admin.from('workout_cardio_logs').insert(
    CARDIO_LOGS.map(([date, distance, elevation_gain]) => ({
      user_id: uid, event_id: `blkspec-${date}-cardio`, event_date: date,
      section: 'exercise', exercise_id: 'uphill', exercise_name: 'Uphill hike',
      distance, elevation_gain, is_autofilled: false,
    })),
  );
});

test('block detail renders attainment computed from real logs', async ({ page }) => {
  await signIn(page, 'agent@apex.local');

  await page.locator('button[title="Training blocks"]').click();
  await expect(page.locator('.block-row__name')).toHaveText(BLOCK.name);
  // 2026-08-03 is the Monday of week 5 of an 8-week block starting 2026-07-06.
  await expect(page.locator('.block-row__week')).toHaveText('week 5 of 8');

  await page.locator('.block-row').click();
  await expect(page.locator('.library-header__title')).toHaveText(BLOCK.name);
  await expect(page.locator('.block-objective')).toContainText('Liberty Ridge');

  // Block-to-date covers the 4 COMPLETED weeks: 4 × 300 = 1200 min target,
  // and 150+180+120+90+260+95+140+160 = 1195 min of cardio logged.
  const toDate = page.locator('.block-section').filter({ hasText: 'Block to date' });
  await expect(toDate).toContainText('1,195 / 1,200 min');

  // Vert: feet only. 2200+3100+1800+1200+4800+1400+2400 = 16,900 ft against
  // 4 × 6000 = 24,000 — the 900 m entry is disclosed, never converted.
  await expect(toDate).toContainText('16,900 / 24,000 ft');
  await expect(toDate.locator('.block-bar__note')).toContainText('900 m');
  await expect(toDate.locator('.block-bar__note')).toContainText('not counted');

  // Every week of the block is listed, with the current one marked.
  await expect(page.locator('.block-weeks tbody tr')).toHaveCount(8);
  await expect(page.locator('.block-weeks__row--current td').first()).toHaveText('5');
});

test('the coach prompt carries pre-computed block attainment', async ({ page }) => {
  // Since W5a the SERVER builds the system prompt: the browser sends only
  // { mode, today, … }. So this proves two things — the client asks for the
  // prompt with the right calendar day, and the server's builder, run here
  // against the same stack, hands the model the numbers already computed
  // plus the framing telling it not to recompute them.
  // The fixture user has no Anthropic key, which disables the chat input.
  // Report one as present: the key is never used, since /api/chat is stubbed.
  await page.route('**/api/profile*', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hasAnthropicKey: true, anthropicKeyLast4: 'abcd' }),
    });
  });

  let chatBody: { mode?: string; today?: string; system?: string } | null = null;
  await page.route('**/api/chat', async route => {
    chatBody = route.request().postDataJSON() as typeof chatBody;
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: `${JSON.stringify({ type: 'text', delta: 'ok' })}\n${JSON.stringify({ type: 'done' })}\n`,
    });
  });

  await signIn(page, 'agent@apex.local');

  await page.locator('.chat-input').fill('How is this block going?');
  await page.locator('.chat-input').press('Enter');
  await expect.poll(() => chatBody, { timeout: 15000 }).not.toBeNull();

  // The v2 body: the fake clock's calendar day, no client-built prompt.
  expect(chatBody).toMatchObject({ mode: 'chat', today: FAKE_NOW.slice(0, 10) });
  expect(chatBody!.system).toBeUndefined();

  const { system: systemPrompt } = await buildChatContext(
    admin as never, await userId('agent@apex.local'), 'chat', chatBody!.today,
  );
  expect(systemPrompt).toContain('<training_block>');
  expect(systemPrompt).toContain('CURRENT BLOCK: Fall Aerobic Foundation — week 5 of 8');
  expect(systemPrompt).toContain('Objective: Liberty Ridge (target 2027-06-15)');
  // The pre-computed figures, not raw logs for the model to add up.
  expect(systemPrompt).toContain('cardio 1,195/1,200 min (100%)');
  expect(systemPrompt).toContain('vertical gain 16,900/24,000 ft (70%)');
  expect(systemPrompt).toContain('not counted — different unit');
  expect(systemPrompt).toMatch(/never recompute or invent/);
});

test('blocks are per-user: a second account sees none', async ({ page }) => {
  await signIn(page, 'agent2@apex.local');
  await page.locator('button[title="Training blocks"]').click();
  await expect(page.locator('.block-empty')).toContainText('No training blocks yet');
  await expect(page.locator('.block-row')).toHaveCount(0);
});

test('an overlapping block is rejected by the database, not the client', async ({ page }) => {
  await signIn(page, 'agent@apex.local');
  await expect(page.locator('.app-main')).toBeVisible({ timeout: 20000 });

  // Posted straight at the endpoint with a valid session, bypassing the form:
  // the guarantee under test is the DB exclusion constraint surfacing as 409.
  const status = await page.evaluate(async () => {
    const raw = Object.keys(localStorage).find(k => k.includes('auth-token'));
    const token = raw ? JSON.parse(localStorage.getItem(raw)!).access_token : '';
    const res = await fetch('/api/blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Overlapping', start_date: '2026-08-24', end_date_exclusive: '2026-09-21',
      }),
    });
    return { code: res.status, body: await res.text() };
  });

  expect(status.code).toBe(409);
  expect(status.body).toContain('overlaps an existing block');
});
