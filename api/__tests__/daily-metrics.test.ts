import { describe, it, expect } from 'vitest';
import { MAX_DAYS_PER_POST, parseDays } from '../_lib/services/dailyMetrics';

// The daily-metrics body (W16 M3b): bounds, field names, the category each
// field needs, and the weigh-in pairing. Writes, consent and the body-weight
// recency rule run against the local stack (integration/daily-metrics).

const TODAY = '2026-10-17';

function ok(raw: unknown) {
  const r = parseDays(raw, TODAY);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

function refusal(raw: unknown): string {
  const r = parseDays(raw, TODAY);
  if (r.ok) throw new Error('expected a refusal');
  expect(r.status).toBe(400);
  return r.message;
}

describe('parseDays', () => {
  it('maps fields to columns and notes the categories they need', () => {
    const [day] = ok([{ date: '2026-10-16', sleepMinutes: 432, restingHr: 52, bodyMassLb: 182.4, bodyMassAt: '2026-10-16T07:10:00Z' }]);
    expect(day.columns).toEqual({ sleep_minutes: 432, resting_hr: 52, body_mass_lb: 182.4, body_mass_at: '2026-10-16T07:10:00Z' });
    expect([...day.categories].sort()).toEqual(['bodyMass', 'dailyMetrics']);
    expect(day.bodyMass).toEqual({ lb: 182.4, at: '2026-10-16T07:10:00.000Z' });
  });

  it('an absent field is absent; null is kept, so it clears', () => {
    const [day] = ok([{ date: '2026-10-16', steps: null }]);
    expect(day.columns).toEqual({ steps: null });
    expect(day.bodyMass).toBeNull();
  });

  it('takes stages and sources as objects', () => {
    const [day] = ok([{ date: '2026-10-16', sleepStages: { core: 200, deep: 80, rem: 100, awake: 20 }, sources: { sleep: 'Apple Watch' } }]);
    expect(day.columns.sleep_stages).toEqual({ core: 200, deep: 80, rem: 100, awake: 20 });
  });

  it('refuses out-of-bounds values, naming the field', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ sleepMinutes: 1441 }, /sleepMinutes/],
      [{ sleepMinutes: 400.5 }, /sleepMinutes/],
      [{ restingHr: 19 }, /restingHr/],
      [{ hrvSdnnMs: 0 }, /hrvSdnnMs/],
      [{ hrvSdnnMs: 1000 }, /hrvSdnnMs/],
      [{ steps: 200_001 }, /steps/],
      [{ bodyMassLb: 1500, bodyMassAt: '2026-10-16T07:00:00Z' }, /bodyMassLb/],
      [{ sleepStages: { light: 30 } }, /sleepStages/],
      [{ sources: { blob: 'x'.repeat(3000) } }, /sources/],
      [{ heartRate: 60 }, /unknown field heartRate/],
    ];
    for (const [fields, message] of cases) {
      expect(refusal([{ date: '2026-10-16', ...fields }]), JSON.stringify(fields)).toMatch(message);
    }
  });

  it('a weigh-in needs its instant, and an instant its weigh-in', () => {
    expect(refusal([{ date: '2026-10-16', bodyMassLb: 182 }])).toMatch(/come together/);
    expect(refusal([{ date: '2026-10-16', bodyMassAt: '2026-10-16T07:00:00Z' }])).toMatch(/come together/);
  });

  it('dates: real, unique, within the last 90 days or tomorrow', () => {
    expect(refusal([{ date: '2026-02-30', steps: 1 }])).toMatch(/YYYY-MM-DD/);
    expect(refusal([{ date: '2026-07-18', steps: 1 }])).toMatch(/outside/);
    expect(refusal([{ date: '2026-10-19', steps: 1 }])).toMatch(/outside/);
    expect(ok([{ date: '2026-10-18', steps: 1 }])).toHaveLength(1);
    expect(refusal([{ date: '2026-10-16', steps: 1 }, { date: '2026-10-16', steps: 2 }])).toMatch(/twice/);
    expect(refusal([{ date: '2026-10-16' }])).toMatch(/no fields/);
  });

  it('a batch is 1–62 days', () => {
    expect(refusal([])).toMatch(/1–62/);
    expect(refusal('days')).toMatch(/1–62/);
    const many = Array.from({ length: MAX_DAYS_PER_POST + 1 }, (_, i) => ({
      date: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10), steps: 1,
    }));
    expect(refusal(many)).toMatch(/1–62/);
  });
});
