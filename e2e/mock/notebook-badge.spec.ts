import type { Page } from '@playwright/test';
import { test, expect } from '../lib/fixtures';

// The profile's "Open the notebook" button counts what waits there for the
// athlete — pending reflections plus unconfirmed memories — and re-reads the
// count when the notebook closes. Zero, or a server without the lists (the
// default mock's `{ ok: true }`), shows no badge.

test.use({ viewport: { width: 375, height: 812 } });

async function openProfile(page: Page) {
  await page.goto('/');
  await expect(page.locator('.day-view')).toBeVisible({ timeout: 20000 });
  await page.locator('.top-nav__avatar').click();
  await expect(page.locator('.profile-view')).toBeVisible();
}

test('no badge when nothing is waiting', async ({ page }) => {
  await openProfile(page);
  await expect(page.getByTestId('open-notebook')).toBeVisible();
  await expect(page.getByTestId('notebook-badge')).toHaveCount(0);
});

/** One memory proposal over a stateful /api/coach-memory; the POST that confirms it commits after `postDelayMs`. */
async function seedMemory(page: Page, postDelayMs = 0) {
  const state = { confirmed: false, posts: 0 };
  await page.route('**/api/coach-memory**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      state.posts += 1;
      if (postDelayMs) await new Promise(r => setTimeout(r, postDelayMs));
      state.confirmed = true;
    }
    const memory = {
      id: 'm1', kind: 'injury', content: 'Left knee: no deep squats', confidence: 0.8,
      source_kind: 'reflection', created_at: '2026-10-13T03:00:00Z',
      confirmed_at: state.confirmed ? '2026-10-14T08:00:00Z' : null, confirmed: state.confirmed,
    };
    const body = req.method() === 'GET' ? { memories: [memory] } : { memory };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return state;
}

/** Reflections as the server lists them (status 'done' only): one waiting, three settled one way or another. */
async function seedReflections(page: Page) {
  const row = (id: string, resolved_at: string | null, resolution: string | null) => ({
    id, day: '2026-10-13', status: 'done', contract_before: 'A', contract_after: 'B',
    reason: 'Because.', memory_proposal_ids: [], created_at: '2026-10-14T03:00:00Z', resolved_at, resolution,
  });
  await page.route('**/api/coach-reflections**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      reflections: [
        row('r1', null, null),
        row('r2', '2026-10-14T08:00:00Z', 'accepted'),
        row('r3', '2026-10-14T08:00:00Z', null),
        row('r4', null, 'rejected'),
      ],
    }),
  }));
}

test('the badge counts proposals and drops one resolved in the notebook', async ({ page }) => {
  const memory = await seedMemory(page);
  await seedReflections(page);

  await openProfile(page);
  const badge = page.getByTestId('notebook-badge');
  await expect(badge).toHaveText('2');
  await expect(badge).toHaveAttribute('aria-label', '2 proposals to review');

  await page.getByTestId('open-notebook').click();
  const notebook = page.getByTestId('notebook');
  await expect(notebook).toBeVisible();
  await notebook.getByTestId('memory-accept').click();
  await expect.poll(() => memory.confirmed).toBe(true);
  await notebook.getByRole('button', { name: 'Close' }).click();
  await expect(notebook).toHaveCount(0);

  await expect(badge).toHaveText('1');
  await expect(badge).toHaveAttribute('aria-label', '1 proposal to review');
});

test('Close straight after Accept, with the POST still in flight, still settles on the new count', async ({ page }) => {
  const memory = await seedMemory(page, 500);
  await seedReflections(page);

  await openProfile(page);
  const badge = page.getByTestId('notebook-badge');
  await expect(badge).toHaveText('2');

  await page.getByTestId('open-notebook').click();
  const notebook = page.getByTestId('notebook');
  await expect(notebook.getByTestId('memory-accept')).toBeVisible();
  await notebook.getByTestId('memory-accept').click();
  await notebook.getByRole('button', { name: 'Close' }).click();
  await expect(notebook).toHaveCount(0);
  // The POST holds for 500ms, so the close's first read sees the proposal still unconfirmed.
  await expect.poll(() => memory.posts).toBe(1);

  await expect(badge).toHaveText('1');
  await expect(badge).toHaveAttribute('aria-label', '1 proposal to review');
});
