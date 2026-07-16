import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

test('tracker starts a session and renders desktop + mobile', async ({ page }) => {
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-set').first()).toBeVisible({ timeout: 15000 });
  await shot(page, 'tracker-desktop');

  const ws = await apexState<{
    eventId: string; session: { started_at: string } | null; isFinished: boolean; elapsedSeconds: number;
  }>(page, 'workoutSession');
  expect(ws.session, 'session created (stubbed or in-memory)').toBeTruthy();
  expect(ws.isFinished).toBe(false);
  expect(ws.elapsedSeconds).toBeGreaterThanOrEqual(0);

  // Prev-column fill: only present when set-tracked exercises have history
  // (stubbed when supabase env exists; absent in offline seed mode).
  const prevBtn = page.locator('button.tracker-set__last').first();
  if (await prevBtn.isVisible().catch(() => false)) {
    await prevBtn.click();
    await shot(page, 'tracker-prev-filled');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.tracker-set').first()).toBeVisible();
  await shot(page, 'tracker-mobile');
});
