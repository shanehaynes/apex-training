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

  test('fills a whole duration from one tap, stopwatch-style', async ({ page }) => {
    await gotoCalendar(page);
    await page.locator('.event-chip__main', { hasText: 'Stretch' }).first().click();
    await page.locator('.modal-completion__btn--start').click();

    const field = page.locator('.tracker-duration').first();
    await expect(field).toBeVisible({ timeout: 15000 });
    await shot(page, 'duration-stopwatch');

    // Digits fill right-to-left: 2,3,0 reads 0:02 → 0:23 → 2:30. One tap,
    // and the display shows exactly what will be stored at every keystroke.
    await field.click();
    await field.press('2');
    await expect(field).toHaveValue('0:02');
    await field.press('3');
    await expect(field).toHaveValue('0:23');
    await field.press('0');
    await expect(field).toHaveValue('2:30');
    await field.blur();
    await expect(field).toHaveValue('2:30');

    // Re-entry starts a fresh buffer (retype, not edit): the stored value
    // moves to the placeholder, and blurring untouched keeps it.
    await field.click();
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', '2:30');
    await field.blur();
    await expect(field).toHaveValue('2:30');

    // A bare digit is that many seconds — the live display disambiguates.
    await field.click();
    await field.press('2');
    await expect(field).toHaveValue('0:02');
    await field.blur();
    await expect(field).toHaveValue('2s');

    // Overflow stays literal while typing and rolls up on commit.
    await field.click();
    await field.pressSequentially('90');
    await expect(field).toHaveValue('0:90');
    await field.blur();
    await expect(field).toHaveValue('1:30');

    // Pasted colon values stay in stopwatch mode.
    await field.fill('2:30');
    await field.blur();
    await expect(field).toHaveValue('2:30');

    // Typing a letter auto-switches to free text, keeping the entry verbatim.
    await field.click();
    await field.pressSequentially('10s on 5s off');
    await field.blur();
    await expect(field).toHaveValue('10s on 5s off');
    await expect(field).toHaveAttribute('inputmode', 'text');

    // Clearing the field returns to stopwatch entry.
    await field.fill('');
    await expect(field).toHaveAttribute('inputmode', 'decimal');
    await expect(field).toHaveAttribute('placeholder', '0:00');
    await field.pressSequentially('45');
    await expect(field).toHaveValue('0:45');
    await field.blur();
    await expect(field).toHaveValue('45s');
  });
});
