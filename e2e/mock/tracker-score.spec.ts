import { test, expect, gotoCalendar, shot } from '../lib/fixtures';

// One scored (For Time) event on the frozen "today", replacing the 503→seed
// fallback: page.route outranks the context-level intercept.
const MURPH_EVENT = {
  id: 'evt-murph',
  type: 'weights',
  title: 'MURPH',
  date: '2026-09-07',
  start_time: null,
  end_time: null,
  estimated_duration: 60,
  description: 'The hero WOD',
  warmup: [],
  exercises: [],
  cooldown: [],
  difficulty: 5,
  location: null,
  cover_image_url: null,
  cardio_targets: null,
  climbing_targets: null,
  tags: [],
  equipment: [],
  is_recurring: false,
  recurrence_rule: null,
  recurring_frequency: null,
  recurring_days: null,
  recurring_end_date: null,
  source: null,
  template_id: 'wt-murph',
  scoring_type: 'for-time',
  time_cap_minutes: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

// A prior finished score for the template — 44:10, the time to beat.
const PRIOR_SESSION = {
  event_date: '2026-06-12',
  score_type: 'for-time',
  score_time_seconds: 2650,
  score_rounds: null,
  score_reps: null,
};

test('finishing a For Time workout asks for the score and celebrates the PR', async ({ page }) => {
  const finishes: Array<Record<string, unknown>> = [];
  await page.route(/rest\/v1\/workout_events/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MURPH_EVENT]) }));
  await page.route(/rest\/v1\/workout_sessions/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([PRIOR_SESSION]) }));
  await page.route('**/api/workout-sessions*', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === 'start') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ session: {
          started_at: new Date().toISOString(), finished_at: null,
          total_duration_seconds: null, coach_summary: null,
          template_id: null, score_type: null, score_time_seconds: null,
          score_rounds: null, score_reps: null,
        } }),
      });
    }
    if (body.action === 'finish') {
      finishes.push(body);
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, totalDurationSeconds: 2492 }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await gotoCalendar(page);

  await page.locator('.event-chip__main', { hasText: 'MURPH' }).first().click();
  await page.locator('.modal-completion__btn--start').click();
  await expect(page.locator('.tracker-header__finish')).toBeVisible();

  // Finish → the score step, not an immediate stamp.
  await page.locator('.tracker-header__finish').click();
  const scoreInput = page.locator('.tracker-score__input');
  await expect(scoreInput).toBeVisible();
  await shot(page, 'tracker-score-prompt');

  // A garbage time is refused in place.
  await scoreInput.fill('fast');
  await page.locator('.tracker-confirm__go', { hasText: 'Save score' }).click();
  await expect(page.locator('.tracker-score__problem')).toBeVisible();

  await scoreInput.fill('41:32');
  await page.locator('.tracker-confirm__go', { hasText: 'Save score' }).click();

  // The summary leads with the workout PR against the 44:10 history.
  await expect(page.locator('.tracker-summary')).toBeVisible();
  await expect(page.locator('.tracker-summary__meta')).toContainText('41:32');
  await expect(page.locator('.tracker-summary__pr').first()).toContainText('MURPH');
  await expect(page.locator('.tracker-summary__pr').first()).toContainText('beating 44:10 on Jun 12');
  await shot(page, 'tracker-score-summary');

  expect(finishes.length).toBe(1);
  expect(finishes[0].score).toEqual({ templateId: 'wt-murph', type: 'for-time', timeSeconds: 2492 });
});
