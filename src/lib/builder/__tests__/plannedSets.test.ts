import { describe, it, expect } from 'vitest';
import {
  formatNumber, parseTarget, pyramidSets, rampSets, resizeSets, setCount, setTarget, tableRows,
  targetFields, topSetBackoffs, uniformSets, unitFor, withPrescriptionPatch,
} from '../plannedSets';
import type { Exercise, PlannedSet } from '../../../types/workout';

const pullUps: Exercise = {
  id: 'stuart-a-3', name: 'Weighted Pull-Ups', category: 'strength', sets: 4, reps: '4–6', weight: '~35 lbs',
};

const weights = (rows: PlannedSet[]) => rows.map(r => r.targetWeight);

describe('targetFields', () => {
  it('shows the dimensions the base prescription names', () => {
    expect(targetFields(pullUps)).toEqual(['targetWeight', 'targetReps']);
    expect(targetFields({ sets: 3, duration: '20–30 sec each side' })).toEqual(['targetDuration']);
  });

  it('adds a dimension only the authored rows name', () => {
    expect(targetFields({ sets: 2, reps: '5', plannedSets: [{ setNumber: 1, targetDuration: '30s' }, { setNumber: 2 }] }))
      .toEqual(['targetReps', 'targetDuration']);
  });

  it('falls back to weight + reps when nothing is named', () => {
    expect(targetFields({ sets: 3 })).toEqual(['targetWeight', 'targetReps']);
  });
});

describe('setCount', () => {
  it('is the prescription count, else the authored rows, else one', () => {
    expect(setCount(pullUps)).toBe(4);
    expect(setCount({ plannedSets: [{ setNumber: 1 }, { setNumber: 2 }] })).toBe(2);
    expect(setCount({ sets: 0, plannedSets: [{ setNumber: 1 }] })).toBe(1);
    expect(setCount({})).toBe(1);
  });
});

describe('uniformSets', () => {
  it('repeats the base prescription once per set, with only the fields it names', () => {
    expect(uniformSets(2, pullUps)).toEqual([
      { setNumber: 1, targetWeight: '~35 lbs', targetReps: '4–6' },
      { setNumber: 2, targetWeight: '~35 lbs', targetReps: '4–6' },
    ]);
  });

  it('never produces an empty table', () => {
    expect(uniformSets(0, pullUps)).toHaveLength(1);
  });
});

describe('resizeSets', () => {
  const ramp: PlannedSet[] = [
    { setNumber: 1, targetWeight: '20 lbs', targetReps: '5' },
    { setNumber: 2, targetWeight: '30 lbs', targetReps: '5' },
    { setNumber: 3, targetWeight: '40 lbs', targetReps: '5' },
  ];

  it('keeps existing rows and repeats the last one for new sets', () => {
    expect(weights(resizeSets(ramp, 5, pullUps))).toEqual(['20 lbs', '30 lbs', '40 lbs', '40 lbs', '40 lbs']);
    expect(resizeSets(ramp, 5, pullUps).map(r => r.setNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops rows past the new count', () => {
    expect(weights(resizeSets(ramp, 2, pullUps))).toEqual(['20 lbs', '30 lbs']);
  });

  it('fills from the base when there is no row to repeat', () => {
    expect(resizeSets([], 2, pullUps)).toEqual(uniformSets(2, pullUps));
  });

  it('renumbers rows that arrived out of order', () => {
    const rows = resizeSets([{ setNumber: 7, targetWeight: '1' }, { setNumber: 9, targetWeight: '2' }], 2, pullUps);
    expect(rows.map(r => r.setNumber)).toEqual([1, 2]);
  });
});

describe('tableRows', () => {
  it('shows the base repeated when nothing is authored', () => {
    expect(tableRows(pullUps)).toEqual(uniformSets(4, pullUps));
  });

  it('shows the authored rows at the current count', () => {
    const entry = { ...pullUps, sets: 5, plannedSets: [{ setNumber: 1, targetWeight: '20 lbs' }, { setNumber: 2, targetWeight: '30 lbs' }] };
    expect(weights(tableRows(entry))).toEqual(['20 lbs', '30 lbs', '30 lbs', '30 lbs', '30 lbs']);
  });
});

describe('setTarget', () => {
  it('edits one cell and clears it on empty text', () => {
    const rows = uniformSets(2, pullUps);
    expect(setTarget(rows, 2, 'targetWeight', ' 40 lbs ')[1]).toEqual({ setNumber: 2, targetWeight: '40 lbs', targetReps: '4–6' });
    expect(setTarget(rows, 1, 'targetReps', '')[0]).toEqual({ setNumber: 1, targetWeight: '~35 lbs' });
    expect(setTarget(rows, 1, 'targetReps', '')[1]).toEqual(rows[1]);
  });
});

describe('parseTarget / unitFor / formatNumber', () => {
  it('reads the first number and the text around it', () => {
    expect(parseTarget('~35 lbs')).toEqual({ value: 35, prefix: '~', suffix: ' lbs' });
    expect(parseTarget('BW + 35 lbs')).toEqual({ value: 35, prefix: 'BW + ', suffix: ' lbs' });
    expect(parseTarget('4–6')).toEqual({ value: 4, prefix: '', suffix: '–6' });
    expect(parseTarget('147.5kg')).toEqual({ value: 147.5, prefix: '', suffix: 'kg' });
    expect(parseTarget('Moderate')).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
  });

  it('takes the typed unit first, then a plain unit off the base, never a range', () => {
    expect(unitFor('20 kg', '~35 lbs')).toBe(' kg');
    expect(unitFor('20', '~35 lbs')).toBe(' lbs');
    expect(unitFor('20', '4–6')).toBe('');
    expect(unitFor('20', 'Moderate')).toBe('');
    expect(unitFor('20', undefined)).toBe('');
  });

  it('formats without float noise or trailing zeros', () => {
    expect(formatNumber(147.5)).toBe('147.5');
    expect(formatNumber(150)).toBe('150');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
  });
});

describe('rampSets', () => {
  it('goes linearly from first to last and keeps the other columns', () => {
    const rows = rampSets(uniformSets(4, pullUps), 'targetWeight', 20, 35, { unit: ' lbs' });
    expect(weights(rows)).toEqual(['20 lbs', '25 lbs', '30 lbs', '35 lbs']);
    expect(rows.map(r => r.targetReps)).toEqual(['4–6', '4–6', '4–6', '4–6']);
  });

  it('snaps weight to plates and reps to whole numbers', () => {
    expect(weights(rampSets(uniformSets(4, pullUps), 'targetWeight', 100, 110))).toEqual(['100', '102.5', '107.5', '110']);
    expect(rampSets(uniformSets(4, pullUps), 'targetReps', 10, 5).map(r => r.targetReps)).toEqual(['10', '8', '7', '5']);
  });

  it('ramps down as readily as up, and a single set gets the first value', () => {
    expect(weights(rampSets(uniformSets(3, pullUps), 'targetWeight', 30, 20))).toEqual(['30', '25', '20']);
    expect(weights(rampSets(uniformSets(1, pullUps), 'targetWeight', 30, 20))).toEqual(['30']);
  });
});

describe('pyramidSets', () => {
  it('climbs to the peak in the middle and comes back down', () => {
    expect(weights(pyramidSets(uniformSets(5, pullUps), 'targetWeight', 135, 185))).toEqual(['135', '160', '185', '160', '135']);
  });

  it('shares the peak side across the two middle sets of an even count', () => {
    expect(pyramidSets(uniformSets(4, pullUps), 'targetReps', 6, 12).map(r => r.targetReps)).toEqual(['6', '10', '10', '6']);
  });

  it('is the peak alone on one set, and low-peak on two', () => {
    expect(weights(pyramidSets(uniformSets(1, pullUps), 'targetWeight', 100, 150))).toEqual(['150']);
    expect(weights(pyramidSets(uniformSets(2, pullUps), 'targetWeight', 100, 150))).toEqual(['100', '100']);
  });
});

describe('topSetBackoffs', () => {
  it('writes the top on the leading sets and the percentage on the trailing ones', () => {
    expect(weights(topSetBackoffs(uniformSets(5, pullUps), 'targetWeight', 200, 3, 80, { unit: ' lbs' })))
      .toEqual(['200 lbs', '200 lbs', '160 lbs', '160 lbs', '160 lbs']);
  });

  it('snaps the back-off to plates', () => {
    expect(weights(topSetBackoffs(uniformSets(2, pullUps), 'targetWeight', 185, 1, 85))).toEqual(['185', '157.5']);
  });

  it('always keeps at least one top set', () => {
    expect(weights(topSetBackoffs(uniformSets(3, pullUps), 'targetWeight', 100, 9, 50))).toEqual(['100', '50', '50']);
    expect(weights(topSetBackoffs(uniformSets(3, pullUps), 'targetWeight', 100, 0, 50))).toEqual(['100', '100', '100']);
  });
});

describe('withPrescriptionPatch', () => {
  const authored: Exercise = {
    ...pullUps,
    plannedSets: [
      { setNumber: 1, targetWeight: '20 lbs', targetReps: '4–6' },
      { setNumber: 2, targetWeight: '25 lbs', targetReps: '4–6' },
      { setNumber: 3, targetWeight: '30 lbs', targetReps: '4–6' },
      { setNumber: 4, targetWeight: '35 lbs', targetReps: '4–6' },
    ],
  };

  it('keeps the authored rows when the base weight or reps change', () => {
    const next = withPrescriptionPatch(authored, { reps: '5', weight: '40 lbs' });
    expect(next.reps).toBe('5');
    expect(next.weight).toBe('40 lbs');
    expect(next.plannedSets).toEqual(authored.plannedSets);
  });

  it('resizes the table when the set count changes', () => {
    expect(weights(withPrescriptionPatch(authored, { sets: 6 }).plannedSets!))
      .toEqual(['20 lbs', '25 lbs', '30 lbs', '35 lbs', '35 lbs', '35 lbs']);
    expect(weights(withPrescriptionPatch(authored, { sets: 2 }).plannedSets!)).toEqual(['20 lbs', '25 lbs']);
  });

  it('leaves the table alone when the count is cleared', () => {
    expect(withPrescriptionPatch(authored, { sets: undefined }).plannedSets).toEqual(authored.plannedSets);
  });

  it('is a plain merge without authored rows', () => {
    expect(withPrescriptionPatch(pullUps, { sets: 6 })).toEqual({ ...pullUps, sets: 6 });
  });
});
