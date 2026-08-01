import { describe, it, expect } from 'vitest';
import { parseReps, repVolume } from '../src/parsers/reps';
import { parseWeight, externalLoadLb } from '../src/parsers/weight';

describe('parseReps', () => {
  it('parses plain numbers', () => {
    expect(parseReps('8')).toEqual({ kind: 'reps', min: 8, max: 8, perSide: false });
  });

  it('parses ranges with hyphen and en-dash', () => {
    expect(parseReps('8-10')).toEqual({ kind: 'reps', min: 8, max: 10, perSide: false });
    expect(parseReps('8–10')).toEqual({ kind: 'reps', min: 8, max: 10, perSide: false });
  });

  it('parses per-side counts', () => {
    expect(parseReps('5 each leg')).toEqual({ kind: 'reps', min: 5, max: 5, perSide: true });
    expect(parseReps('15 each arm')).toEqual({ kind: 'reps', min: 15, max: 15, perSide: true });
    expect(parseReps('10 per side')).toEqual({ kind: 'reps', min: 10, max: 10, perSide: true });
  });

  it('parses timed prescriptions', () => {
    expect(parseReps('30 sec')).toEqual({ kind: 'time', seconds: 30, perSide: false });
    expect(parseReps('2 min')).toEqual({ kind: 'time', seconds: 120, perSide: false });
    expect(parseReps('20-30 sec each side')).toEqual({ kind: 'time', seconds: 25, perSide: true });
  });

  it('recognizes AMRAP', () => {
    expect(parseReps('AMRAP')).toEqual({ kind: 'amrap' });
    expect(parseReps('max reps')).toEqual({ kind: 'amrap' });
  });

  it('flags unparseable strings instead of dropping them', () => {
    expect(parseReps('a few good ones')).toEqual({ kind: 'unparseable', raw: 'a few good ones' });
    expect(parseReps('')).toEqual({ kind: 'unparseable', raw: '' });
    expect(parseReps(undefined)).toEqual({ kind: 'unparseable', raw: '' });
  });

  it('computes rep volume with per-side doubling', () => {
    expect(repVolume(parseReps('8-10'))).toBe(9);
    expect(repVolume(parseReps('5 each leg'))).toBe(10);
    expect(repVolume(parseReps('30 sec'))).toBeNull();
  });
});

describe('parseWeight', () => {
  it('parses pounds with and without units', () => {
    expect(parseWeight('25lb')).toEqual({ kind: 'weight', lb: 25 });
    expect(parseWeight('25 lbs')).toEqual({ kind: 'weight', lb: 25 });
    expect(parseWeight('45')).toEqual({ kind: 'weight', lb: 45 });
  });

  it('converts kilograms', () => {
    const parsed = parseWeight('10 kg');
    expect(parsed.kind).toBe('weight');
    if (parsed.kind === 'weight') expect(parsed.lb).toBeCloseTo(22.05, 1);
  });

  it('parses bodyweight variants', () => {
    expect(parseWeight('BW')).toEqual({ kind: 'bodyweight', extraLb: 0 });
    expect(parseWeight('bodyweight')).toEqual({ kind: 'bodyweight', extraLb: 0 });
    expect(parseWeight('BW+25')).toEqual({ kind: 'bodyweight', extraLb: 25 });
  });

  it('flags unparseable strings', () => {
    expect(parseWeight('heavy-ish')).toEqual({ kind: 'unparseable', raw: 'heavy-ish' });
  });

  it('resolves cap qualifiers to their bound', () => {
    expect(parseWeight('≤50 lb')).toEqual({ kind: 'weight', lb: 50 });
    expect(parseWeight('<= 50')).toEqual({ kind: 'weight', lb: 50 });
    expect(parseWeight('under 45 lb')).toEqual({ kind: 'weight', lb: 45 });
    expect(parseWeight('max 40')).toEqual({ kind: 'weight', lb: 40 });
    expect(parseWeight('up to 50 lb')).toEqual({ kind: 'weight', lb: 50 });
  });

  it('externalLoadLb compares by added load', () => {
    expect(externalLoadLb(parseWeight('60 lb'))).toBe(60);
    expect(externalLoadLb(parseWeight('BW+40'))).toBe(40);
    expect(externalLoadLb(parseWeight('moderate'))).toBeNull();
  });
});
