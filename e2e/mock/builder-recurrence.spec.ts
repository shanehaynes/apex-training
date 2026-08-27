import { test, expect, apexState, gotoCalendar, shot } from '../lib/fixtures';

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

test('repeat picker serializes a weekly rule and snaps the anchor date', async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await page.route('**/api/events*', route => {
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await gotoCalendar(page);

  await page.getByTestId('nav-add-workout').click();
  await page.locator('.builder-search__create').click();
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill('Repeat Spec');

  // Off by default; a dayless repeat is refused at Apply.
  const repeatSwitch = page.locator('.builder-repeat__switch');
  await expect(repeatSwitch).toHaveText('Off');
  await repeatSwitch.click();
  await page.locator('.exercise-editor__save').click();
  await expect(page.getByText('at least one day').first()).toBeVisible();

  // Mondays and Wednesdays, every 2 weeks.
  await page.getByLabel('Repeat on MO').click();
  await page.getByLabel('Repeat on WE').click();
  await page.locator('.builder-repeat__interval-input').fill('2');
  await shot(page, 'builder-repeat');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  expect(posts.length, 'exactly one event POST').toBe(1);
  expect(posts[0].recurrence_rule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  expect(posts[0].is_recurring).toBe(true);
  // Anchor snapped onto a selected weekday (Mon=1 / Wed=3) — the engine
  // renders the anchor at its own date, so a stray weekday would show.
  expect([1, 3]).toContain(weekdayOf(posts[0].date as string));
});

test('editing a recurring occurrence asks for scope: series PATCHes, detach POSTs', async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  const detaches: Array<Record<string, unknown>> = [];
  await page.route('**/api/events*', route => {
    if (route.request().method() === 'PATCH') patches.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/event-instances*', route => {
    detaches.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"stub"}' });
  });
  await gotoCalendar(page);

  // Find a recurring occurrence whose rule the picker can express (the seed
  // also holds legacy-pattern series, which render the card read-only).
  const schedule = await apexState<{ events: Array<{ title: string; isRecurring: boolean; recurrenceRule?: string }> }>(page, 'schedule');
  const recurring = schedule.events.find(e =>
    e.isRecurring && e.recurrenceRule?.startsWith('FREQ=WEEKLY;BYDAY='));
  expect(recurring, 'the bundled seed has a weekly recurring event').toBeTruthy();
  await page.locator('.event-chip__main', { hasText: recurring!.title }).first().click();
  await page.locator('.modal-edit-workout').click();

  // The repeat card reflects the live series rule, with no off switch.
  await expect(page.locator('.builder-repeat__day--active').first()).toBeVisible();
  await expect(page.locator('.builder-repeat__switch')).toHaveCount(0);

  // Whole-series save: one PATCH, schedule fields excluded.
  await page.locator('.library-field', { hasText: 'Title' }).locator('input').fill('Series Renamed');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.builder-scope__question')).toBeVisible();
  await shot(page, 'builder-scope-chooser');
  await page.locator('.exercise-editor__save', { hasText: 'Whole series' }).click();
  await expect(page.locator('.composer-view')).toHaveCount(0);
  expect(patches.length).toBe(1);
  const fields = patches[0].fields as Record<string, unknown>;
  expect(fields.title).toBe('Series Renamed');
  expect('date' in fields).toBe(false);
  expect(fields.recurrence_rule, 'weekly rule rewritten series-wide').toContain('FREQ=WEEKLY');

  // This-event-only save: a detach POST carrying a fresh standalone id.
  await page.locator('.event-chip__main', { hasText: 'Series Renamed' }).first().click();
  await page.locator('.modal-edit-workout').click();
  await page.locator('.library-field', { hasText: 'Location' }).locator('input').fill('Detached gym');
  await page.locator('.exercise-editor__save').click();
  await page.locator('.exercise-editor__save', { hasText: 'This event only' }).click();
  await expect(page.locator('.composer-view')).toHaveCount(0);
  expect(detaches.length).toBe(1);
  expect(detaches[0].action).toBe('detach');
  const detachedEvent = detaches[0].event as Record<string, unknown>;
  expect(String(detachedEvent.id)).not.toContain('__');
  expect(detachedEvent.is_recurring).toBe(false);
  expect(detachedEvent.location).toBe('Detached gym');
});
