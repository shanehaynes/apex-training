import { describe, it, expect } from 'vitest';
import { asksScope, saveRequest } from '../exerciseScope';

// The decision behind "Save exercises": a series occurrence asks This day
// only / Whole series; a one-off never does, whatever scope is offered.

const oneOff = { id: 'w1-mon-stretch', isRecurring: false };
const occurrence = { id: 'w1-mon-morning__2026-06-22', isRecurring: true };
// The anchor row itself: a base id, but still a series.
const anchor = { id: 'w1-mon-morning', isRecurring: true };

describe('asksScope', () => {
  it('asks on a series occurrence and on the anchor, never on a one-off', () => {
    expect(asksScope(occurrence)).toBe(true);
    expect(asksScope(anchor)).toBe(true);
    expect(asksScope(oneOff)).toBe(false);
  });

  it('trusts the occurrence id even when the flag disagrees', () => {
    expect(asksScope({ id: 'w1-mon-morning__2026-06-22', isRecurring: false })).toBe(true);
  });
});

describe('saveRequest', () => {
  it('a one-off PATCHes itself whatever scope is passed', () => {
    expect(saveRequest(oneOff)).toEqual({ kind: 'update', id: 'w1-mon-stretch' });
    expect(saveRequest(oneOff, 'occurrence')).toEqual({ kind: 'update', id: 'w1-mon-stretch' });
    expect(saveRequest(oneOff, 'series')).toEqual({ kind: 'update', id: 'w1-mon-stretch' });
  });

  it('"this day only" on a series detaches the occurrence the modal holds', () => {
    expect(saveRequest(occurrence, 'occurrence')).toEqual({ kind: 'detach', eventId: 'w1-mon-morning__2026-06-22' });
    // The anchor has no date in its id — the provider resolves it, so the
    // request still carries the id as held.
    expect(saveRequest(anchor, 'occurrence')).toEqual({ kind: 'detach', eventId: 'w1-mon-morning' });
  });

  it('"whole series" PATCHes the base id, never the occurrence id', () => {
    expect(saveRequest(occurrence, 'series')).toEqual({ kind: 'update', id: 'w1-mon-morning' });
  });
});
