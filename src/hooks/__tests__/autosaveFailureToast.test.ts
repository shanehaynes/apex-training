import { describe, expect, it } from 'vitest';
import { autosaveFailureToast } from '../useWorkoutSession';
import { AutosaveError } from '../../lib/tracking/sessionRepo';

const SET = ['set|exercise|x1|1'];
const fail = (status: number | null, message = 'Autosave failed') => new AutosaveError(message, status);

describe('autosaveFailureToast', () => {
  it('toasts a transient failure once per streak, then leaves it to the Unsaved bar', () => {
    for (const err of [fail(null), fail(500), fail(503), fail(408), fail(429)]) {
      expect(autosaveFailureToast(err, SET, true)).toBe('Autosave failed');
      expect(autosaveFailureToast(err, SET, false)).toBeNull();
    }
  });

  it('pauses on auth, naming what clears it, even mid-streak', () => {
    expect(autosaveFailureToast(fail(401), SET, true)).toBe('Autosave paused — sign in again, then Retry');
    expect(autosaveFailureToast(fail(403), SET, false))
      .toBe('Autosave paused — the terms changed; accept them from Profile, then Retry');
  });

  it("shows a single-key refusal's own message, and never the generic toast", () => {
    expect(autosaveFailureToast(fail(422, 'Weight must be a number'), SET, true))
      .toBe('Autosave refused: Weight must be a number');
    expect(autosaveFailureToast(fail(400, 'x'.repeat(200)), SET, false)).toBe(`Autosave refused: ${'x'.repeat(140)}`);
  });

  it('stays silent for a refused batch (the queue isolates it) and a refused removal (nothing to edit)', () => {
    expect(autosaveFailureToast(fail(422), [...SET, 'set|exercise|x1|2'], true)).toBeNull();
    expect(autosaveFailureToast(fail(422), ['removed|exercise|x1|3'], true)).toBeNull();
  });
});
