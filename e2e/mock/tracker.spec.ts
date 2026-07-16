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

  test('shows the mm:ss equivalent live and canonicalizes on commit', async ({ page }) => {
    await gotoCalendar(page);
    await page.locator('.event-chip__main', { hasText: 'Stretch' }).first().click();
    await page.locator('.modal-completion__btn--start').click();

    const input = page.locator('.tracker-duration .tracker-input').first();
    await expect(input).toBeVisible({ timeout: 15000 });

    // Seconds spelling: hint shows the equivalence while typing…
    await input.fill('90');
    await expect(page.locator('.tracker-duration__hint')).toHaveText('= 1:30');
    // …and the value is rewritten to the canonical form on blur.
    await input.blur();
    await expect(input).toHaveValue('1:30');
    await expect(page.locator('.tracker-duration__hint')).toHaveCount(0);

    // mm:ss and unit spellings converge to the same canonical value.
    await input.fill('2 min');
    await input.press('Enter');
    await expect(input).toHaveValue('2:00');

    // Unparseable free text is kept verbatim.
    await input.fill('10s on 5s off');
    await input.blur();
    await expect(input).toHaveValue('10s on 5s off');
  });
});
