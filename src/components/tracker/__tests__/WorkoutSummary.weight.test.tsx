import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkoutSummary from '../WorkoutSummary';
import { AuthContext, type AuthContextValue } from '../../../context/auth';
import { buildTrackerModel } from '../../../lib/tracking/plan';
import { estimateOneRepMax, type PersonalRecord } from '../../../lib/tracking/records';
import { LB_PER_KG, type WeightContext } from '../../../lib/tracking/weight';
import type { SetLogRow } from '../../../lib/db/types';
import type { WorkoutEvent } from '../../../types/workout';

vi.mock('../../../hooks/useCoachReachable', () => ({ useCoachReachable: () => true }));

// The summary reads the session's weights with the profile's context and
// shows them in its unit: a kg lifter's bare "100" is 100 kg in the volume
// line, and a record reads in kg — the same numbers the review shows.

const event = {
  id: 'evt', date: '2026-08-20', title: 'Bench day', type: 'weights',
  exercises: [{ id: 'bench', name: 'Bench Press', category: 'strength', sets: 3, reps: '5' }],
} as unknown as WorkoutEvent;

function row(setNumber: number, weight: string, isWarmup = false): SetLogRow {
  return {
    event_id: 'evt', event_date: '2026-08-20', section: 'exercise', exercise_id: 'bench', exercise_name: 'Bench Press',
    set_number: setNumber, planned_weight: null, planned_reps: '5', planned_duration: null,
    actual_weight: weight, actual_reps: '5', actual_duration: null, is_autofilled: false, is_warmup: isWarmup,
  } as SetLogRow;
}

// A warm-up 60 × 5, then a bare 100 × 5 and an explicit 100 kg × 5.
const groups = buildTrackerModel(event, [row(1, '60', true), row(2, '100'), row(3, '100 kg')], []);

const pr: PersonalRecord = {
  kind: 'oneRM', exerciseName: 'Bench Press', previousDate: '2026-08-10',
  weight: 100 * LB_PER_KG, reps: 5,
  estimatedOneRM: estimateOneRepMax(100 * LB_PER_KG, 5),
  previousOneRM: estimateOneRepMax(90 * LB_PER_KG, 5),
};

function render(weightContext: WeightContext) {
  return renderToStaticMarkup(
    <AuthContext.Provider value={{ weightContext } as AuthContextValue}>
      <WorkoutSummary
        event={event}
        accentColor="#123456"
        durationSeconds={1800}
        groups={groups}
        prs={[pr]}
        score={null}
        scoreRecord={null}
        coachText="Solid session."
        coachStatus="ready"
        onClose={() => {}}
        onDone={() => {}}
        onAskCoach={() => {}}
      />
    </AuthContext.Provider>,
  );
}

const tonnageOf = (html: string) => /data-testid="summary-tonnage"[^>]*>([^<]*)</.exec(html)?.[1];

describe('WorkoutSummary — the profile weight context', () => {
  it('a kg lifter: bare numbers are kg, the volume is in kg, warm-ups count nothing', () => {
    const html = render({ unit: 'kg', bodyWeightLb: null });
    // (100 + 100) kg × 5 — the 60 kg warm-up adds nothing.
    expect(tonnageOf(html)).toBe('Volume 1,000');
    expect(html).toContain('Weight × reps in kg over working sets');
  });

  it("a kg lifter's record reads in kg", () => {
    const html = render({ unit: 'kg', bodyWeightLb: null });
    expect(html).toContain('<strong>Bench Press</strong> — est. best single lift 117 (100 × 5), up from 105 on Aug 10');
  });

  it('a pounds lifter: bare numbers are pounds, and the volume stays in pounds', () => {
    const html = render({ unit: 'lb', bodyWeightLb: null });
    // 100 lb × 5 + 220.462 lb × 5 = 1602.31 → 1,602.
    expect(tonnageOf(html)).toBe('Volume 1,602');
    expect(html).toContain('Weight × reps in lb over working sets');
    expect(html).toContain('est. best single lift 257 (220 × 5), up from 231 on Aug 10');
  });
});
