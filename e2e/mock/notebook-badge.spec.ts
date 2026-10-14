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

test('the badge counts proposals and drops one resolved in the notebook', async ({ page }) => {
  let memoryConfirmed = false;
  await page.route('**/api/coach-memory**', route => {
    const req = route.request();
    if (req.method() === 'POST') memoryConfirmed = true;
    const memory = {
      id: 'm1', kind: 'injury', content: 'Left knee: no deep squats', confidence: 0.8,
      source_kind: 'reflection', created_at: '2026-10-13T03:00:00Z',
      confirmed_at: memoryConfirmed ? '2026-10-14T08:00:00Z' : null, confirmed: memoryConfirmed,
    };
    const body = req.method() === 'GET' ? { memories: [memory] } : { memory };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/coach-reflections**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      reflections: [{
        id: 'r1', day: '2026-10-13', status: 'pending', contract_before: 'A', contract_after: 'B',
        reason: 'Because.', memory_proposal_ids: ['m1'], created_at: '2026-10-14T03:00:00Z',
        resolved_at: null, resolution: null,
      }],
    }),
  }));

  await openProfile(page);
  const badge = page.getByTestId('notebook-badge');
  await expect(badge).toHaveText('2');
  await expect(badge).toHaveAttribute('aria-label', '2 proposals to review');

  await page.getByTestId('open-notebook').click();
  const notebook = page.getByTestId('notebook');
  await expect(notebook).toBeVisible();
  await notebook.getByTestId('memory-accept').click();
  await expect.poll(() => memoryConfirmed).toBe(true);
  await notebook.getByRole('button', { name: 'Close' }).click();
  await expect(notebook).toHaveCount(0);

  await expect(badge).toHaveText('1');
  await expect(badge).toHaveAttribute('aria-label', '1 proposal to review');
});
