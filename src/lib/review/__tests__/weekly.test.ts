import { describe, it, expect } from 'vitest';
import {
  isIsoDate, isoWeekOf, isWeeklyReviewDocument, isWeeklyReviewResponse, shiftWeek, weekLabel,
  type WeeklyReviewDocument,
} from '../weekly';

// The client's half of the weekly review: the ISO-week helpers the overlay
// navigates with, and the shape guard that stands between a response and
// the renderer.

const DOC: WeeklyReviewDocument = {
  week: { start: '2026-09-21', end: '2026-09-27' },
  planVsDone: { planned: 3, completed: 2, minutesPlanned: 285, minutesDone: 242, misses: [{ eventId: 'wed-run', title: 'Easy run', date: '2026-09-23' }] },
  physiology: { summary: 'Steady.', flags: ['No strength work logged'] },
  doctrine: { topic: 'recovery', line: 'Prefer the smaller session done to the larger session skipped, in every phase.', verdict: 'aligned', note: 'Kept it short.' },
  memoryProposals: [{ kind: 'preference', content: 'Prefers evenings', why: 'Every session after 5 PM.' }],
  nextWeek: [{ tool: 'create_event', input: { type: 'cardio', title: 'Easy run', date: '2026-09-30', estimated_duration: 40 }, why: 'Replace the miss.' }],
  headline: 'You did the big day and skipped the small one.',
};

describe('weeks', () => {
  it('finds the Monday–Sunday ISO week of any date, across month and year edges', () => {
    expect(isoWeekOf('2026-09-24')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(isoWeekOf('2026-09-27')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(isoWeekOf('2026-09-28')).toEqual({ start: '2026-09-28', end: '2026-10-04' });
    expect(isoWeekOf('2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
  });

  it('shifts by whole weeks and labels a week within or across months', () => {
    expect(shiftWeek({ start: '2026-09-21', end: '2026-09-27' }, 1)).toEqual({ start: '2026-09-28', end: '2026-10-04' });
    expect(shiftWeek({ start: '2026-09-21', end: '2026-09-27' }, -2)).toEqual({ start: '2026-09-07', end: '2026-09-13' });
    expect(weekLabel({ start: '2026-09-21', end: '2026-09-27' })).toBe('Sep 21 – 27, 2026');
    expect(weekLabel({ start: '2026-09-28', end: '2026-10-04' })).toBe('Sep 28 – Oct 4, 2026');
  });

  it('accepts only real YYYY-MM-DD dates', () => {
    expect(isIsoDate('2026-09-21')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-1')).toBe(false);
    expect(isIsoDate(20260921)).toBe(false);
  });
});

describe('isWeeklyReviewDocument', () => {
  it('accepts the full shape, a null doctrine, empty lists and a miss without a why', () => {
    expect(isWeeklyReviewDocument(DOC)).toBe(true);
    expect(isWeeklyReviewDocument({ ...DOC, doctrine: null, memoryProposals: [], nextWeek: [] })).toBe(true);
    expect(isWeeklyReviewDocument({ ...DOC, planVsDone: { ...DOC.planVsDone, misses: [{ eventId: 'x', title: 'y', date: '2026-09-23', why: 'late' }] } })).toBe(true);
  });

  it('refuses a missing section, a wrong enum, a bad date, a negative count and a non-object input', () => {
    const { physiology: _p, ...noPhysiology } = DOC;
    expect(isWeeklyReviewDocument(noPhysiology)).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, doctrine: { ...DOC.doctrine, verdict: 'fine' } })).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, week: { start: '2026-09-21', end: 'sunday' } })).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, planVsDone: { ...DOC.planVsDone, completed: -1 } })).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, memoryProposals: [{ kind: 'wish', content: 'x', why: '' }] })).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, nextWeek: [{ tool: 'delete_event', input: {}, why: '' }] })).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, nextWeek: [{ tool: 'create_event', input: 'x', why: '' }] })).toBe(false);
    expect(isWeeklyReviewDocument({ ...DOC, headline: 3 })).toBe(false);
    expect(isWeeklyReviewDocument(null)).toBe(false);
    expect(isWeeklyReviewDocument([DOC])).toBe(false);
  });
});

describe('isWeeklyReviewResponse', () => {
  it('needs the document, the model badge fields, the warnings and the timestamp', () => {
    const good = { document: DOC, model: { id: 'claude-opus-5-5', label: 'Opus 5.5', badge: 'claude opus 5.5' }, warnings: [], generatedAt: '2026-09-28T08:00:00Z' };
    expect(isWeeklyReviewResponse(good)).toBe(true);
    expect(isWeeklyReviewResponse({ ...good, document: {} })).toBe(false);
    expect(isWeeklyReviewResponse({ ...good, model: { id: 'x' } })).toBe(false);
    expect(isWeeklyReviewResponse({ ...good, warnings: 'none' })).toBe(false);
    expect(isWeeklyReviewResponse(undefined)).toBe(false);
  });
});
