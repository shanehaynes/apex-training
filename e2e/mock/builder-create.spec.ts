import type { Page } from '@playwright/test';
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

/**
 * Watch the builder's wire. Since #136 every Apply and Save changes is ONE
 * POST /api/workout-draft, so `legacy` is the real assertion: the old
 * client-side sequence (template upsert, then event insert or PATCH or
 * detach) is gone, not merely unused. Observed, never fulfilled — the
 * context-level stub answers with the service's own shapes.
 */
function watchDraftWrites(page: Page) {
  const drafts: Array<Record<string, unknown>> = [];
  const legacy: string[] = [];
  page.on('request', req => {
    const { pathname } = new URL(req.url());
    if (pathname === '/api/workout-draft') drafts.push(req.postDataJSON());
    else if (req.method() !== 'GET' && ['/api/events', '/api/event-instances', '/api/workout-templates'].includes(pathname)) {
      legacy.push(`${req.method()} ${pathname}`);
    }
  });
  return { drafts, legacy };
}

test('top-nav add opens the builder; scoring selector; apply posts one draft', async ({ page }) => {
  const wire = watchDraftWrites(page);
  await gotoCalendar(page);

  // Direct entry point: the builder no longer hides behind the day modal.
  await page.getByTestId('nav-add-workout').click();
  await expect(page.locator('.builder-search')).toBeVisible();
  // The step states its job — this page schedules, it doesn't manage templates.
  await expect(page.locator('.builder-search__intro')).toContainText('Scheduling for');
  await expect(page.locator('.builder-search__create')).toHaveText(/Build a new workout/);
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

  // AMRAP without a cap is still refused, but the refusal is the SERVER's
  // now: the draft posts, comes back `ok: false`, and the problem toasts.
  // That is why a refused Apply costs a request where it used to cost none.
  await page.locator('.exercise-editor__save').click();
  await expect(page.getByText('time cap').first()).toBeVisible();
  await expect(page.locator('.composer-view'), 'a refusal keeps the form open').toBeVisible();
  expect(wire.drafts.length, 'the refused Apply posted too').toBe(1);

  // With a cap, the stub applies it like the service would and the builder closes.
  await cap.fill('40');
  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  // One endpoint, one body: the draft, today, and which write to perform.
  expect(wire.drafts.length).toBe(2);
  const body = wire.drafts[1];
  expect(Object.keys(body).sort()).toEqual(['action', 'draft', 'today']);
  expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.action).toEqual({ kind: 'create' });
  const draft = body.draft as Record<string, unknown>;
  expect(draft.title).toBe('MURPH');
  expect(draft.scoringType).toBe('amrap');
  expect(draft.timeCap, 'the cap travels as typed; the server parses it').toBe('40');
  expect(wire.legacy, 'the client-side sequence is gone').toEqual([]);
});

test('picking a library template fills the form and keeps its identity', async ({ page }) => {
  // Page-scoped stub outranks the context-level empty list.
  await page.route(/rest\/v1\/workout_templates/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CINDY_ROW]) }));
  const wire = watchDraftWrites(page);
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

  await page.locator('.exercise-editor__save').click();
  await expect(page.locator('.composer-view')).toHaveCount(0);

  // The picked template's id rides in the draft — that identity is what keeps
  // a named workout's score history continuous — and so do the superset
  // letters the editor assigned. The server resolves identity and upserts;
  // the browser no longer saves the template itself.
  expect(wire.drafts.length, 'exactly one POST').toBe(1);
  const draft = wire.drafts[0].draft as {
    templateId: string;
    lists: { exercises: Array<{ superset?: string }> };
  };
  expect(draft.templateId).toBe('wt-cindy');
  expect(draft.lists.exercises.map(e => e.superset)).toEqual(['A', 'A']);
  expect(wire.legacy, 'no separate template upsert').toEqual([]);
});
