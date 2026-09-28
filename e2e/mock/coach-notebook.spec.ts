import type { Page, Request } from '@playwright/test';
import { test, expect, shot } from '../lib/fixtures';

// The coach notebook (lane D02), on a phone: opened from the profile's Coach
// section, it shows the seeded memory — a proposal waiting on the athlete on
// top, the confirmed facts grouped by kind below — and Accept moves the
// proposal into its kind's group with one POST { id }. Forget on a confirmed
// row is one DELETE { id }; the add-a-fact form is one POST { kind, content }
// and the new fact lands on top of its group. The contract tab reads the
// default mock profile (no coachContract, the pre-D01 shape) as "not
// available yet"; with a D01-shaped profile and a pending reflection it
// renders the editor and the diff card, and Accept / Save / the opt-in
// each make the request they should. The doctrine tab lists every topic and
// expands one.
//
// The default mock intercept answers every /api/* it does not know with
// `{ ok: true }` (no `memories`, no `reflections`); the page.route calls
// here outrank it. Every route here answers the OPTIONS preflight-free same
// origin the app calls, so no CORS headers are needed.

/** One row as /api/coach-memory lists it (src/lib/coach/memory.ts CoachMemory). */
interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  confidence: number | null;
  source_kind: string | null;
  created_at: string;
  confirmed_at: string | null;
  confirmed: boolean;
}

const PROPOSAL: MemoryRow = {
  id: '11111111-2222-4333-8444-555555555555',
  kind: 'injury',
  content: 'Left knee: no deep squats until the physio clears it',
  confidence: 0.8,
  source_kind: 'reflection',
  created_at: '2026-09-07T03:00:00Z',
  confirmed_at: null,
  confirmed: false,
};

const GOAL: MemoryRow = {
  id: '22222222-2222-4333-8444-555555555555',
  kind: 'goal',
  content: 'Rainier, June 2027',
  confidence: null,
  source_kind: 'user',
  created_at: '2026-09-01T08:00:00Z',
  confirmed_at: '2026-09-01T08:00:00Z',
  confirmed: true,
};

const PREFERENCE: MemoryRow = {
  id: '33333333-2222-4333-8444-555555555555',
  kind: 'preference',
  content: 'Trains before work, never after 7pm',
  confidence: null,
  source_kind: 'chat',
  created_at: '2026-08-20T08:00:00Z',
  confirmed_at: '2026-08-21T08:00:00Z',
  confirmed: true,
};

const ADDED_ID = '44444444-2222-4333-8444-555555555555';

/** A stateful /api/coach-memory: GET lists, POST { id } confirms, POST { kind, content } adds, DELETE archives. */
function seedMemory(page: Page, rows: MemoryRow[] = [PROPOSAL, GOAL, PREFERENCE]) {
  const requests: Request[] = [];
  let list: MemoryRow[] = [...rows];
  const route = page.route('**/api/coach-memory**', route => {
    const req = route.request();
    requests.push(req);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET') return json({ memories: list });
    if (req.method() === 'DELETE') {
      const { id } = req.postDataJSON() as { id: string };
      list = list.filter(m => m.id !== id);
      return json({ ok: true });
    }
    const body = req.postDataJSON() as { id?: string; kind?: string; content?: string };
    if (body.id) {
      const row = list.find(m => m.id === body.id);
      if (!row) return json('Memory not found', 404);
      const confirmed = { ...row, confirmed: true, confirmed_at: '2026-09-07T09:00:00Z' };
      list = list.map(m => (m.id === row.id ? confirmed : m));
      return json({ memory: confirmed });
    }
    const added: MemoryRow = {
      ...GOAL, id: ADDED_ID, kind: body.kind ?? 'note', content: body.content ?? '',
      created_at: '2026-09-07T10:00:00Z', confirmed_at: '2026-09-07T10:00:00Z',
    };
    list = [added, ...list];
    return json({ memory: added });
  });
  return { route, requests };
}

const posts = (requests: Request[]) => requests.filter(r => r.method() === 'POST');
const deletes = (requests: Request[]) => requests.filter(r => r.method() === 'DELETE');

/** Load the phone calendar, open the profile, open the notebook. */
async function openNotebook(page: Page) {
  await page.goto('/');
  await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
  await page.getByTestId('open-notebook').click();
  await expect(page.getByTestId('notebook')).toBeVisible();
}

test.use({ viewport: { width: 375, height: 812 } });

test('a seeded proposal sits on top; Accept confirms it with one POST and moves it into its kind', async ({ page }) => {
  const { route, requests } = seedMemory(page);
  await route;
  await openNotebook(page);

  // Memory is the first tab, and the read happened on open (dev StrictMode
  // mounts twice, so the count is at least one, not exactly one).
  await expect(page.getByTestId('notebook-tab-memory')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => requests.filter(r => r.method() === 'GET').length).toBeGreaterThanOrEqual(1);

  // The proposal, whole, with its kind and provenance, above the confirmed groups.
  const proposal = page.getByTestId('memory-proposal');
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText(PROPOSAL.content);
  await expect(proposal).toContainText('from an overnight reflection');
  const proposalsBox = await page.getByTestId('memory-proposals').boundingBox();
  const confirmedBox = await page.getByTestId('memory-confirmed').boundingBox();
  expect(proposalsBox!.y, 'proposals sit above the confirmed list').toBeLessThan(confirmedBox!.y);

  // Confirmed rows: goals before preferences (the prompt's order), no injuries group yet.
  await expect(page.getByTestId('memory-group-goal')).toContainText(GOAL.content);
  await expect(page.getByTestId('memory-group-preference')).toContainText(PREFERENCE.content);
  await expect(page.getByTestId('memory-group-injury')).toHaveCount(0);
  await shot(page, 'coach-notebook-memory');

  // Accept: one POST { id }, the proposal section goes, an injuries group appears with the fact.
  await proposal.getByTestId('memory-accept').click();
  await expect(page.getByTestId('memory-proposal')).toHaveCount(0);
  await expect(page.getByTestId('memory-proposals')).toHaveCount(0);
  await expect(page.getByTestId('memory-group-injury')).toContainText(PROPOSAL.content);
  await expect.poll(() => posts(requests).length).toBe(1);
  expect(posts(requests)[0].postDataJSON()).toEqual({ id: PROPOSAL.id });

  // The injuries group leads, because injuries constrain the programming first.
  const injuryBox = await page.getByTestId('memory-group-injury').boundingBox();
  const goalBox = await page.getByTestId('memory-group-goal').boundingBox();
  expect(injuryBox!.y).toBeLessThan(goalBox!.y);
});

test('Forget archives a confirmed fact with one DELETE, and the add form keeps a new one on top of its group', async ({ page }) => {
  const { route, requests } = seedMemory(page, [GOAL, PREFERENCE]);
  await route;
  await openNotebook(page);

  await expect(page.getByTestId('memory-proposals')).toHaveCount(0);
  await expect(page.getByTestId('memory-row')).toHaveCount(2);

  // Forget the preference: the row goes, its group with it, one DELETE { id }.
  await page.getByTestId('memory-group-preference').getByRole('button', { name: 'Forget this' }).click();
  await expect(page.getByTestId('memory-group-preference')).toHaveCount(0);
  await expect(page.getByTestId('memory-row')).toHaveCount(1);
  await expect.poll(() => deletes(requests).length).toBe(1);
  expect(deletes(requests)[0].postDataJSON()).toEqual({ id: PREFERENCE.id });

  // Add a goal: the button wakes with text, one POST { kind, content }, the
  // new fact leads the goals group, the form clears.
  const form = page.getByTestId('memory-add');
  const keep = form.getByRole('button', { name: 'Keep this' });
  await expect(keep).toBeDisabled();
  await form.getByLabel('Kind of fact').selectOption('goal');
  await form.getByLabel('The fact to remember').fill('  Sub-3 marathon,   spring 2027 ');
  await expect(form).toContainText('27 / 500');
  await keep.click();
  await expect.poll(() => posts(requests).length).toBe(1);
  expect(posts(requests)[0].postDataJSON()).toEqual({ kind: 'goal', content: 'Sub-3 marathon, spring 2027' });
  const goalRows = page.getByTestId('memory-group-goal').getByTestId('memory-row');
  await expect(goalRows).toHaveCount(2);
  await expect(goalRows.first()).toContainText('Sub-3 marathon, spring 2027');
  await expect(form.getByLabel('The fact to remember')).toHaveValue('');
});

test('with no memory at all the tab speaks in the coach’s voice, and Escape returns to the profile', async ({ page }) => {
  const { route } = seedMemory(page, []);
  await route;
  await openNotebook(page);
  await expect(page.getByTestId('memory-empty')).toContainText("I don't hold anything about you yet");
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('notebook')).toHaveCount(0);
  await expect(page.locator('.profile-view')).toBeVisible();
});

test('the contract tab reads a pre-D01 profile (no coachContract) as not available yet, never an error', async ({ page, consoleErrors }) => {
  const { route } = seedMemory(page, []);
  await route;
  await openNotebook(page);
  await page.getByTestId('notebook-tab-contract').click();
  await expect(page.getByTestId('contract-unavailable')).toContainText("isn't available yet");
  await expect(page.getByTestId('contract-editor')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  await shot(page, 'coach-notebook-contract-unavailable');
});

const CONTRACT = 'Push me on consistency, not volume.\nAsk before moving a long day.';
const REFLECTION = {
  id: '55555555-2222-4333-8444-555555555555',
  day: '2026-09-06',
  status: 'pending',
  contract_before: CONTRACT,
  contract_after: 'Push me on consistency, not volume.\nNever program through knee pain.\nAsk before moving a long day.',
  reason: 'You mentioned the knee twice this week and I programmed through it once.',
  memory_proposal_ids: [PROPOSAL.id],
  created_at: '2026-09-07T03:00:00Z',
  resolved_at: null,
  resolution: null,
};

/** A D01-shaped GET /api/profile (the key status the app already needs, plus the contract fields). */
async function stubContractProfile(page: Page, requests: Request[]) {
  await page.route('**/api/profile', route => {
    const req = route.request();
    requests.push(req);
    if (req.method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hasAnthropicKey: true,
        anthropicKeyLast4: 'abcd',
        termsAccepted: { termsVersion: 'terms-v1', privacyVersion: 'privacy-v1', acceptedAt: '2026-08-29T00:00:00.000Z' },
        termsCurrent: true,
        coachContract: CONTRACT,
        reflectionOptIn: false,
      }),
    });
  });
}

test('with a D01-shaped profile the contract tab edits and saves, shows a reflection as a diff card, and accepts it', async ({ page }) => {
  const { route } = seedMemory(page, [PROPOSAL]);
  await route;
  const profileRequests: Request[] = [];
  await stubContractProfile(page, profileRequests);
  const reflectionRequests: Request[] = [];
  await page.route('**/api/coach-reflections**', route => {
    const req = route.request();
    reflectionRequests.push(req);
    const body = req.method() === 'GET' ? { reflections: [REFLECTION] } : { ok: true };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await openNotebook(page);
  await page.getByTestId('notebook-tab-contract').click();

  // The editor holds the contract; Save sleeps until it changes.
  const editor = page.getByLabel('Coaching contract');
  await expect(editor).toHaveValue(CONTRACT);
  await expect(page.getByTestId('contract-save')).toBeDisabled();
  await expect(page.getByTestId('contract-unavailable')).toHaveCount(0);

  // The pending reflection: day, reason, the added line marked on the after side only, the memory note.
  const card = page.getByTestId('reflection-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Sunday 6 September');
  await expect(card).toContainText(REFLECTION.reason);
  const changed = card.locator('.notebook-diff__line--changed');
  await expect(changed).toHaveCount(1);
  await expect(changed).toHaveText('Never program through knee pain.');
  await expect(card).toContainText('Also proposes one memory');
  await shot(page, 'coach-notebook-contract');

  // Accept: one POST { id, resolution }, the card goes, the editor follows the accepted text.
  await card.getByTestId('reflection-accept').click();
  await expect(page.getByTestId('reflection-card')).toHaveCount(0);
  await expect(editor).toHaveValue(REFLECTION.contract_after);
  await expect(page.getByTestId('contract-save')).toBeDisabled();
  await expect.poll(() => posts(reflectionRequests).length).toBe(1);
  expect(posts(reflectionRequests)[0].postDataJSON()).toEqual({ id: REFLECTION.id, resolution: 'accepted' });
  await expect(page.getByTestId('contract-history')).toContainText('Past reflections (1)');

  // Edit and save: one PATCH { coach_contract }, then "Saved" and the button sleeps again.
  await editor.fill('Be blunt.');
  await expect(page.getByTestId('contract-editor')).toContainText('9 / 2000');
  await page.getByTestId('contract-save').click();
  await expect(page.getByTestId('contract-editor')).toContainText('Saved');
  await expect(page.getByTestId('contract-save')).toBeDisabled();
  const patches = profileRequests.filter(r => r.method() === 'PATCH');
  expect(patches.map(r => r.postDataJSON())).toEqual([{ coach_contract: 'Be blunt.' }]);

  // The opt-in: one PATCH { reflection_opt_in: true }.
  await page.getByTestId('reflection-opt-in').check();
  await expect.poll(() => profileRequests.filter(r => r.method() === 'PATCH').length).toBe(2);
  expect(profileRequests.filter(r => r.method() === 'PATCH')[1].postDataJSON()).toEqual({ reflection_opt_in: true });
});

/** A reflection that proposes memories only: the contract is untouched, and the server sends no contract_after. */
const MEMORY_ONLY_REFLECTION = {
  ...REFLECTION,
  id: '66666666-2222-4333-8444-555555555555',
  day: '2026-09-05',
  contract_before: null,
  contract_after: null,
  reason: 'Two things worth remembering came up.',
  memory_proposal_ids: [PROPOSAL.id, GOAL.id],
};

test('a refused accept rolls the card back and leaves the editor untouched; a memory-only accept never empties it', async ({ page, consoleErrors }) => {
  const { route } = seedMemory(page, [PROPOSAL]);
  await route;
  const profileRequests: Request[] = [];
  await stubContractProfile(page, profileRequests);
  const reflectionRequests: Request[] = [];
  let refuse = true;
  await page.route('**/api/coach-reflections**', route => {
    const req = route.request();
    reflectionRequests.push(req);
    if (req.method() === 'GET') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ reflections: [REFLECTION, MEMORY_ONLY_REFLECTION] }),
      });
    }
    if (refuse) return route.fulfill({ status: 500, contentType: 'text/plain', body: 'Failed to resolve reflection' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await openNotebook(page);
  await page.getByTestId('notebook-tab-contract').click();
  const editor = page.getByLabel('Coaching contract');
  await expect(editor).toHaveValue(CONTRACT);
  const cards = page.getByTestId('reflection-card');
  await expect(cards).toHaveCount(2);

  // The contract-changing card: the server refuses, so the card comes back,
  // the editor still holds the old contract, Save still sleeps, and the
  // athlete is told.
  const changing = page.locator('[data-reflection-id="55555555-2222-4333-8444-555555555555"]');
  await changing.getByTestId('reflection-accept').click();
  await expect.poll(() => posts(reflectionRequests).length).toBe(1);
  await expect(page.locator('.toast')).toContainText('Accepting the change failed');
  await expect(cards).toHaveCount(2);
  await expect(changing).toBeVisible();
  await expect(editor).toHaveValue(CONTRACT);
  await expect(page.getByTestId('contract-save')).toBeDisabled();
  await expect(page.getByTestId('contract-history')).toHaveCount(0);
  // The browser logs every 5xx as a console error; this one is the test's
  // own doing, so it is claimed here — exactly one — and the fixture's
  // no-console-errors assertion still guards everything else.
  await expect.poll(() => consoleErrors.filter(e => e.includes('status of 500')).length).toBe(1);
  consoleErrors.splice(consoleErrors.findIndex(e => e.includes('status of 500')), 1);

  // The memory-only card, accepted for real: it resolves, and the editor is
  // exactly as it was — a null contract_after is not an empty contract.
  refuse = false;
  const memoryOnly = page.locator('[data-reflection-id="66666666-2222-4333-8444-555555555555"]');
  await expect(memoryOnly.getByTestId('reflection-diff')).toHaveCount(0);
  await expect(memoryOnly).toContainText('Also proposes 2 memories');
  await memoryOnly.getByTestId('reflection-accept').click();
  await expect(cards).toHaveCount(1);
  await expect.poll(() => posts(reflectionRequests).length).toBe(2);
  expect(posts(reflectionRequests)[1].postDataJSON()).toEqual({ id: MEMORY_ONLY_REFLECTION.id, resolution: 'accepted' });
  await expect(editor).toHaveValue(CONTRACT);
  await expect(page.getByTestId('contract-save')).toBeDisabled();
  await expect(page.getByTestId('contract-history')).toContainText('Past reflections (1)');

  // A draft typed while the last accept was in flight is kept: accept the
  // contract-changing card with text in the editor and only the baseline
  // moves, so Save stays awake for the draft.
  await editor.fill('My own words.');
  await changing.getByTestId('reflection-accept').click();
  await expect(cards).toHaveCount(0);
  await expect(editor).toHaveValue('My own words.');
  await expect(page.getByTestId('contract-save')).toBeEnabled();
  expect(profileRequests.filter(r => r.method() === 'PATCH')).toHaveLength(0);
});

test('the doctrine tab lists every topic and expands one into headed prose', async ({ page }) => {
  const { route } = seedMemory(page, []);
  await route;
  await openNotebook(page);
  await page.getByTestId('notebook-tab-doctrine').click();

  const topics = page.getByTestId('doctrine-topic');
  await expect(topics).toHaveCount(8);
  await expect(topics.first()).toHaveAttribute('data-topic', 'principles');
  await expect(topics.first().locator('.notebook-topic__body')).toBeHidden();

  await topics.nth(5).locator('summary').click();
  await expect(topics.nth(5)).toHaveAttribute('data-topic', 'recovery');
  const body = topics.nth(5).locator('.notebook-topic__body');
  await expect(body).toBeVisible();
  await expect(body.locator('h4').first()).toBeVisible();
  await expect(body.locator('ol li').first()).toBeVisible();
  await shot(page, 'coach-notebook-doctrine');
});
