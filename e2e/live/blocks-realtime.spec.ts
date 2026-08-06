// Cross-device sync for training blocks: two browser contexts signed in as
// the SAME user, a write in one, asserted in the other with no reload.
//
// This is the layer nothing else covers. Realtime needs three things to line
// up — publication membership, an RLS SELECT policy, and a replica identity
// that carries the columns the policy reads — and only an end-to-end test
// proves all three hold at once. DELETE is asserted separately from
// INSERT/UPDATE because it is the case that fails when replica identity is
// primary-key-only: the old row reaching Realtime has no user_id to check
// `auth.uid() = user_id` against, so the event is dropped rather than
// delivered, and the second device silently keeps showing a deleted block.

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
// @ts-expect-error plain-JS helper shared with the seed scripts
import { localSupabaseEnv } from '../../scripts/lib/localEnv.mjs';

const env = localSupabaseEnv();
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

const FAKE_NOW = '2026-08-03T08:00:00';

async function userId(email: string): Promise<string> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const user = data.users.find(u => u.email === email);
  if (!user) throw new Error(`missing fixture user ${email}`);
  return user.id;
}

async function openBlocks(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(v => {
    (window as unknown as { __APEX_FAKE_NOW__?: string }).__APEX_FAKE_NOW__ = v;
  }, FAKE_NOW);
  await page.goto('/');
  // Two pages in one context share the stored session, so the second one
  // lands already signed in — sign in only when the gate is actually shown.
  const gate = page.locator('.auth-card');
  const blocksButton = page.locator('button[title="Training blocks"]');
  await expect(gate.or(blocksButton).first()).toBeVisible({ timeout: 20000 });
  if (await gate.isVisible()) {
    await page.locator('input[name="email"]').fill('agent@apex.local');
    await page.locator('input[name="password"]').fill('apex-agent-password');
    await page.locator('.auth-submit').click();
  }
  await blocksButton.click();
  return page;
}

/** Block names visible in the list, via the dev bridge (no DOM timing games). */
async function blockNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = (window as unknown as {
      __apex?: { state(k: string): { blocks?: Array<{ name: string }> } };
    }).__apex?.state('blocks');
    return (state?.blocks ?? []).map(b => b.name);
  });
}

test.beforeEach(async () => {
  const uid = await userId('agent@apex.local');
  await admin.from('training_blocks').delete().eq('user_id', uid);
  await admin.from('objectives').delete().eq('user_id', uid);
});

test('a block created on one device appears on the other', async ({ browser }) => {
  const context = await browser.newContext();
  const deviceA = await openBlocks(context);
  const deviceB = await openBlocks(context);

  await expect.poll(() => blockNames(deviceA), { timeout: 15000 }).toEqual([]);

  const uid = await userId('agent@apex.local');
  await admin.from('training_blocks').insert({
    user_id: uid, name: 'Realtime Insert', intent: '',
    start_date: '2026-08-03', end_date_exclusive: '2026-08-31', weekly_targets: {},
  });

  await expect.poll(() => blockNames(deviceB), { timeout: 15000 }).toEqual(['Realtime Insert']);
  await context.close();
});

test('a rename on one device reaches the other', async ({ browser }) => {
  const uid = await userId('agent@apex.local');
  const { data: created } = await admin.from('training_blocks').insert({
    user_id: uid, name: 'Before Rename', intent: '',
    start_date: '2026-08-03', end_date_exclusive: '2026-08-31', weekly_targets: {},
  }).select('id').single();

  const context = await browser.newContext();
  const deviceB = await openBlocks(context);
  await expect.poll(() => blockNames(deviceB), { timeout: 15000 }).toEqual(['Before Rename']);

  await admin.from('training_blocks').update({ name: 'After Rename' }).eq('id', created!.id);

  await expect.poll(() => blockNames(deviceB), { timeout: 15000 }).toEqual(['After Rename']);
  await context.close();
});

test('a block deleted on one device disappears from the other', async ({ browser }) => {
  const uid = await userId('agent@apex.local');
  const { data: created } = await admin.from('training_blocks').insert({
    user_id: uid, name: 'Doomed Block', intent: '',
    start_date: '2026-08-03', end_date_exclusive: '2026-08-31', weekly_targets: {},
  }).select('id').single();

  const context = await browser.newContext();
  const deviceB = await openBlocks(context);
  await expect.poll(() => blockNames(deviceB), { timeout: 15000 }).toEqual(['Doomed Block']);

  await admin.from('training_blocks').delete().eq('id', created!.id);

  // Needs REPLICA IDENTITY FULL: with the default (primary key only) the old
  // row carries just `id`, Realtime cannot evaluate the SELECT policy, and
  // this poll times out with the block still on screen.
  await expect.poll(() => blockNames(deviceB), { timeout: 15000 }).toEqual([]);
  await context.close();
});

test('an objective deleted on one device disappears from the other', async ({ browser }) => {
  const uid = await userId('agent@apex.local');
  const { data: created } = await admin.from('objectives').insert({
    user_id: uid, name: 'Doomed Objective', notes: '',
  }).select('id').single();

  const context = await browser.newContext();
  const deviceB = await openBlocks(context);
  await expect
    .poll(() => deviceB.evaluate(() => {
      const s = (window as unknown as {
        __apex?: { state(k: string): { objectives?: Array<{ name: string }> } };
      }).__apex?.state('blocks');
      return (s?.objectives ?? []).map(o => o.name);
    }), { timeout: 15000 })
    .toEqual(['Doomed Objective']);

  await admin.from('objectives').delete().eq('id', created!.id);

  await expect
    .poll(() => deviceB.evaluate(() => {
      const s = (window as unknown as {
        __apex?: { state(k: string): { objectives?: Array<{ name: string }> } };
      }).__apex?.state('blocks');
      return (s?.objectives ?? []).map(o => o.name);
    }), { timeout: 15000 })
    .toEqual([]);
  await context.close();
});
