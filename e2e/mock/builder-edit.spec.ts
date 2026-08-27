import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

test('edit workout opens the builder prefilled; save patches the event', async ({ page }) => {
  // Capture the PATCH the builder sends on Save changes.
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/events*', route => {
    if (route.request().method() === 'PATCH') {
      patches.push({ url: route.request().url(), body: route.request().postDataJSON() });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await gotoCalendar(page);

  // A one-off event — recurring ones detour through the series scope chooser
  // (covered by builder-recurrence.spec.ts).
  const schedule = await apexState<{ events: Array<{ title: string; isRecurring: boolean }> }>(page, 'schedule');
  const oneOff = schedule.events.find(e => !e.isRecurring);
  expect(oneOff, 'the bundled seed has a one-off event').toBeTruthy();
  await page.locator('.event-chip__main', { hasText: oneOff!.title }).first().click();
  const originalTitle = (await page.locator('.modal-title').textContent())!.trim();
  await page.locator('.modal-edit-workout').click();
  await expect(page.locator('.modal'), 'builder replaces the workout modal').toHaveCount(0);
  await expect(page.locator('.builder-search'), 'edit mode skips the search step').toHaveCount(0);
  await expect(page.locator('.composer-form')).toBeVisible();

  const title = page.locator('.library-field', { hasText: 'Title' }).locator('input');
  await expect(title).toHaveValue(originalTitle);
  await shot(page, 'builder-edit-prefilled');

  // Every field is editable here — the piecemeal modal never offered these.
  await title.fill('Edited In Builder');
  await page.locator('.library-field', { hasText: 'Location' }).locator('input').fill('Garage gym');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  expect(patches.length, 'exactly one PATCH').toBe(1);
  const fields = patches[0].body.fields as Record<string, unknown>;
  expect(fields.title).toBe('Edited In Builder');
  expect(fields.location).toBe('Garage gym');
  await shot(page, 'builder-edit-saved');
});
