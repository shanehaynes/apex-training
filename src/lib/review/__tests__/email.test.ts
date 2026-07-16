import { describe, it, expect } from 'vitest';
import type { CompletionRow, SetLogRow } from '../../db/types';
import { renderReviewEmail } from '../email';
import { buildReviewPeriod, computeReviewStats, computeYearlyStats } from '../stats';
import type { ReviewInputs } from '../types';

const MONTH = buildReviewPeriod('month', 2026, 6); // May 18 – Jun 14, 2026

function makeCompletion(date: string, type: string, title = `${type} session`): CompletionRow {
  return {
    event_id: `evt-${date}-${type}`,
    event_date: date,
    event_type: type,
    event_title: title,
    duration_minutes: 60,
    is_completed: true,
    completed_at: `${date}T12:00:00Z`,
    updated_at: `${date}T12:00:00Z`,
  };
}

function makeSet(date: string, name: string, weight: string, reps: string): SetLogRow {
  return {
    event_id: `evt-${date}`,
    event_date: date,
    section: 'exercise',
    exercise_id: 'x',
    exercise_name: name,
    set_number: 1,
    planned_weight: null,
    planned_reps: null,
    planned_duration: null,
    actual_weight: weight,
    actual_reps: reps,
    actual_duration: null,
    is_autofilled: false,
  };
}

function monthInputs(overrides: Partial<ReviewInputs> = {}): ReviewInputs {
  return {
    period: MONTH,
    completions: [makeCompletion('2026-05-20', 'weights'), makeCompletion('2026-05-22', 'cardio')],
    sessions: [],
    setLogs: [makeSet('2026-04-01', 'Bench Press', '100', '5'), makeSet('2026-05-20', 'Bench Press', '110', '5')],
    cardioLogs: [],
    ...overrides,
  };
}

describe('renderReviewEmail — monthly', () => {
  const stats = computeReviewStats(monthInputs());

  it('builds the month subject from the period range', () => {
    expect(renderReviewEmail(stats, null, 'Shane').subject).toBe('Your training month in review: May 18 – Jun 14');
  });

  it('includes key figures in both html and text', () => {
    const { html, text } = renderReviewEmail(stats, null, 'Shane');
    for (const body of [html, text]) {
      expect(body).toContain('Bench Press');
      expect(body).toContain('550'); // tonnage 110×5
      expect(body).toContain('Shane');
    }
    expect(html).toContain('month 6 of 13');
  });

  it('renders the AI block only when commentary exists', () => {
    const withOut = renderReviewEmail(stats, null, 'Shane');
    expect(withOut.html).not.toContain('your coach');

    const withAI = renderReviewEmail(stats, 'Big month. That bench PR was earned.', 'Shane');
    expect(withAI.html).toContain('Big month. That bench PR was earned.');
    expect(withAI.html).toContain('your coach');
    expect(withAI.text).toContain('Big month. That bench PR was earned.');
  });

  it('escapes html in dynamic content', () => {
    const evil = computeReviewStats(
      monthInputs({ setLogs: [makeSet('2026-04-01', '<script>alert(1)</script>', '100', '5'), makeSet('2026-05-20', '<script>alert(1)</script>', '110', '5')] }),
    );
    const { html } = renderReviewEmail(evil, '<b>bold</b> claim', 'Shane');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says so when there are no PRs', () => {
    const quiet = computeReviewStats(monthInputs({ setLogs: [] }));
    const { html } = renderReviewEmail(quiet, null, 'Shane');
    expect(html).toContain('No personal records this period.');
  });
});

describe('renderReviewEmail — yearly', () => {
  const stats = computeYearlyStats(monthInputs({ period: buildReviewPeriod('year', 2026) }));

  it('builds the year subject and retrospective sections', () => {
    const { subject, html } = renderReviewEmail(stats, null, 'Shane');
    expect(subject).toBe('Your 2026 year in training');
    expect(html).toContain('The year, month by month');
    expect(html).toContain('Month 13');
    expect(html).toContain('Best month');
  });
});
