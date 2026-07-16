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

test.describe('duration input', () => {
  test.use({ fakeNow: '2026-06-24T20:00:00' });

  test('enters minutes and seconds unambiguously', async ({ page }) => {
    await gotoCalendar(page);
    await page.locator('.event-chip__main', { hasText: 'Stretch' }).first().click();
    await page.locator('.modal-completion__btn--start').click();

    const cell = page.locator('.tracker-duration').first();
    await expect(cell).toBeVisible({ timeout: 15000 });
    await shot(page, 'duration-split');
    const min = cell.locator('.tracker-duration__field').nth(0);
    const sec = cell.locator('.tracker-duration__field').nth(1);
    const mode = cell.locator('.tracker-duration__mode');

    // The whole point: a bare "2" is two minutes, not two seconds.
    await min.fill('2');
    await min.blur();
    await expect(min).toHaveValue('2');
    await expect(sec).toHaveValue('00');
    // Custom mode shows the committed canonical string — proves what was stored.
    await mode.click();
    await expect(cell.locator('.tracker-input')).toHaveValue('2:00');
    await mode.click();

    // Minutes and seconds combine into one canonical value.
    await min.fill('2');
    await sec.fill('30');
    await sec.blur();
    await mode.click();
    await expect(cell.locator('.tracker-input')).toHaveValue('2:30');

    // The escape hatch keeps interval-style free text verbatim.
    const text = cell.locator('.tracker-input');
    await text.fill('10s on 5s off');
    await text.blur();
    await expect(text).toHaveValue('10s on 5s off');
  });
});
