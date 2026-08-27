import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// One library template, served to the page-scoped stub below. Snake_case row
// shape mirrors rowToTemplate (src/lib/schedule/templates.ts).
const CINDY_ROW = {
  id: 'wt-cindy',
  title: 'CINDY',
  type: 'weights',
  scoring_type: 'amrap',
  time_cap_minutes: 20,
  estimated_duration: 25,
  difficulty: 4,
  description: '5 pull-ups, 10 push-ups, 15 squats',
  warmup: [],
  exercises: [
    { id: 'ex-1', name: 'Pull-up', category: 'strength', reps: '5', superset: 'A' },
    { id: 'ex-2', name: 'Push-up', category: 'strength', reps: '10', superset: 'A' },
  ],
  cooldown: [],
  location: null,
  tags: ['benchmark'],
  equipment: [],
  cardio_targets: null,
  climbing_targets: null,
  archived_at: null,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

test('top-nav add opens the builder; scoring selector; apply closes', async ({ page }) => {
  await gotoCalendar(page);

  // Direct entry point: the builder no longer hides behind the day modal.
  await page.getByTestId('nav-add-workout').click();
  await expect(page.locator('.builder-search')).toBeVisible();
  await expect(page.locator('.builder-search__empty'), 'empty library explains itself').toBeVisible();

  // The typed query becomes the new workout's title.
  await page.locator('.library-search__input').fill('MURPH');
  await page.locator('.builder-search__create').click();
  await expect(page.locator('.library-field', { hasText: 'Title' }).locator('input')).toHaveValue('MURPH');

  // Scoring selector: hint follows the choice, AMRAP reveals the time cap.
  await page.locator('.builder-scoring__btn', { hasText: 'For Time' }).click();
  await expect(page.locator('.builder-scoring__hint')).toContainText('fastest');
  await expect(page.locator('.builder-scoring__cap')).toHaveCount(0);
  await page.locator('.builder-scoring__btn', { hasText: 'AMRAP' }).click();
  const cap = page.locator('.builder-scoring__cap input');
  await expect(cap).toBeVisible();
  await shot(page, 'builder-scoring');

  // AMRAP without a cap is refused; with one, Apply stubs through and closes.
  await page.locator('.exercise-editor__save').click();
  await expect(page.getByText('time cap').first()).toBeVisible();
  await cap.fill('40');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);
});

test('picking a library template fills the form and keeps its identity', async ({ page }) => {
  // Page-scoped stub outranks the context-level empty list.
  await page.route(/rest\/v1\/workout_templates/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CINDY_ROW]) }));
  await gotoCalendar(page);

  await page.getByTestId('nav-add-workout').click();
  const card = page.locator('.builder-template-card');
  await expect(card).toHaveCount(1);
  await expect(card, 'card shows the scoring badge').toContainText('AMRAP 20 min');
  await shot(page, 'builder-library');

  // Substring filter, never fuzzy.
  await page.locator('.library-search__input').fill('cin');
  await expect(card).toHaveCount(1);
  await page.locator('.library-search__input').fill('cyndi');
  await expect(page.locator('.builder-template-card')).toHaveCount(0);
  await page.locator('.library-search__input').fill('');

  await page.locator('.builder-template-card__main').click();
  await expect(page.locator('.library-field', { hasText: 'Title' }).locator('input')).toHaveValue('CINDY');
  await expect(page.locator('.builder-scoring__btn--active')).toHaveText('AMRAP');
  await expect(page.locator('.builder-scoring__cap input')).toHaveValue('20');
  await expect(page.locator('.composer-exercises'), 'template exercises fill the sections').toContainText('Pull-up');

  // The stored superset pair renders as group badges; unlink dissolves the
  // pair (a superset of one is meaningless), relink restores it.
  await expect(page.locator('.superset-badge')).toHaveCount(2);
  await shot(page, 'builder-template-filled');
  await page.locator('.editor-card__link').last().click();
  await expect(page.locator('.superset-badge')).toHaveCount(0);
  await page.locator('.editor-card__link').last().click();
  await expect(page.locator('.superset-badge')).toHaveCount(2);

  // Apply → both stubbed writes succeed → builder closes; the template
  // upsert carries the group labels.
  const templatePosts: Array<Record<string, unknown>> = [];
  await page.route('**/api/workout-templates*', route => {
    templatePosts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"wt-cindy"}' });
  });
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);
  const savedExercises = templatePosts[0].exercises as Array<{ superset?: string }>;
  expect(savedExercises.map(e => e.superset)).toEqual(['A', 'A']);
});
