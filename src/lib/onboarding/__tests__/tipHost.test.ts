import { describe, it, expect } from 'vitest';
import { pickTip, tipBodySegments, tipsEligible, type TipCandidate } from '../tipHost';
import { TIPS, type TipId } from '../tips/index';
import { getTipCandidates, registerTip } from '../tipsStore';

// A small fixed catalog, so the ordering rules are tested rather than
// whatever the real catalog's priorities happen to be this week.
const CATALOG = [
  { id: 'a', priority: 1 },
  { id: 'b', priority: 0 },
  { id: 'c', priority: 1 },
  { id: 'd', priority: 2 },
] as const;

const cand = (id: string, conditioned = false): TipCandidate => ({ id: id as TipId, conditioned });
const none = new Set<string>();

describe('pickTip', () => {
  it('returns null with nothing registered', () => {
    expect(pickTip([], none, CATALOG)).toBeNull();
  });

  it('prefers the lowest priority number', () => {
    expect(pickTip([cand('a'), cand('d'), cand('b')], none, CATALOG)).toBe('b');
  });

  it('breaks a priority tie in favour of a conditioned tip', () => {
    expect(pickTip([cand('a'), cand('c', true)], none, CATALOG)).toBe('c');
  });

  it('does not let a condition outrank priority', () => {
    expect(pickTip([cand('d', true), cand('a')], none, CATALOG)).toBe('a');
  });

  it('falls back to catalog order, whatever the registration order', () => {
    expect(pickTip([cand('c'), cand('a')], none, CATALOG)).toBe('a');
    expect(pickTip([cand('c', true), cand('a', true)], none, CATALOG)).toBe('a');
  });

  it('skips tips already seen', () => {
    expect(pickTip([cand('b'), cand('a')], new Set(['b']), CATALOG)).toBe('a');
    expect(pickTip([cand('b')], new Set(['b']), CATALOG)).toBeNull();
  });

  it('ignores an id the catalog does not know', () => {
    expect(pickTip([cand('zzz', true)], none, CATALOG)).toBeNull();
  });

  it('works over the real catalog', () => {
    const [first, second] = TIPS;
    expect(pickTip([cand(second.id), cand(first.id)], none, TIPS))
      .toBe(first.priority <= second.priority ? first.id : second.id);
  });
});

describe('tipsEligible', () => {
  const settled = { is_template_source: false, onboarding_dismissed_at: '2026-09-01T00:00:00Z' };

  it('allows a settled ordinary account', () => {
    expect(tipsEligible(settled, false)).toBe(true);
  });

  it('refuses before the profile loads', () => {
    expect(tipsEligible(null, false)).toBe(false);
  });

  it('refuses while the welcome flow is still due', () => {
    expect(tipsEligible({ ...settled, onboarding_dismissed_at: null }, false)).toBe(false);
  });

  it('refuses the template source account', () => {
    expect(tipsEligible({ ...settled, is_template_source: true }, false)).toBe(false);
  });

  it('refuses when the kill switch is set', () => {
    expect(tipsEligible(settled, true)).toBe(false);
  });
});

describe('tipBodySegments', () => {
  it('turns **x** into bold and leaves the rest as text', () => {
    expect(tipBodySegments('Press **Start Workout** to log. Or **Mark as Complete**.')).toEqual([
      { text: 'Press ', bold: false },
      { text: 'Start Workout', bold: true },
      { text: ' to log. Or ', bold: false },
      { text: 'Mark as Complete', bold: true },
      { text: '.', bold: false },
    ]);
  });

  it('leaves unpaired markers alone', () => {
    expect(tipBodySegments('a ** b')).toEqual([{ text: 'a ** b', bold: false }]);
  });

  it('renders every real tip body without stray markers', () => {
    for (const tip of TIPS) {
      const plain = tipBodySegments(tip.body).map(s => s.text).join('');
      expect(plain, tip.id).not.toContain('**');
    }
  });
});

describe('tip candidate store', () => {
  it('merges duplicate registrations and withdraws each independently', () => {
    const [first] = TIPS;
    const offA = registerTip(first.id, false);
    const offB = registerTip(first.id, true);
    expect(getTipCandidates()).toEqual([{ id: first.id, conditioned: true }]);

    offB();
    expect(getTipCandidates()).toEqual([{ id: first.id, conditioned: false }]);
    offB(); // a second call is a no-op, not a second withdrawal
    expect(getTipCandidates()).toHaveLength(1);

    offA();
    expect(getTipCandidates()).toEqual([]);
  });
});
