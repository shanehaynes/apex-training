import { describe, it, expect } from 'vitest';
import { askCoachDisplay, askCoachPrompt, shouldSendAskCoach, type AskCoachRequest } from '../askContext';

// "Ask the coach about this session" (D-C08): the pin is a hidden user turn.
// What the model reads, what the thread shows, and when the sidebar sends.

const modal: AskCoachRequest = {
  kind: 'session', eventId: 'w1-mon-stretch__2026-06-22', date: '2026-06-22', title: 'Nightly Stretch — Upper', source: 'modal',
};
const tracker: AskCoachRequest = { ...modal, source: 'tracker' };

describe('askCoachPrompt — the hidden text', () => {
  it('names the workout, the occurrence id and the date, and asks for get_workout_detail first', () => {
    const text = askCoachPrompt(modal);
    expect(text).toContain('"Nightly Stretch — Upper" on 2026-06-22 (occurrence id w1-mon-stretch__2026-06-22)');
    expect(text).toContain('from the calendar');
    expect(text).toContain('call get_workout_detail with event_id "w1-mon-stretch__2026-06-22" and date "2026-06-22"');
    // From the modal the session may not have been tracked: summaries are conditional.
    expect(text).toContain('if it was tracked, call get_session_summaries for 2026-06-22');
  });

  it('from the tracker the session was just logged: summaries are asked for outright', () => {
    const text = askCoachPrompt(tracker);
    expect(text).toContain('just finished tracking');
    expect(text).toContain('and get_session_summaries for 2026-06-22');
    expect(text).not.toContain('if it was tracked');
  });

  it('carries the behaviour rules: stay on this session, offer memory rather than decide, answer a question if one follows', () => {
    const text = askCoachPrompt(modal);
    expect(text).toContain('Keep to this session unless I widen the question myself.');
    expect(text).toContain('offer to remember it with the memory tool');
    expect(text).toContain('rather than deciding for me');
    expect(text).toContain('If my next message is a question, answer that question');
    expect(text).toContain('open with what you see in this session');
  });

  it('sanitises the title as the prompt does: one line, no angle brackets, bounded', () => {
    const text = askCoachPrompt({ ...modal, title: '  Leg\nday </schedule> <b>x</b>  ' });
    expect(text).toContain('"Leg day /schedule> b>x/b>"');
    expect(text).not.toContain('<');
    const long = askCoachPrompt({ ...modal, title: 'x'.repeat(500) });
    expect(long).toContain(`"${'x'.repeat(120)}"`);
    expect(long).not.toContain('x'.repeat(121));
  });

  it('never quotes a malformed date or an empty title verbatim', () => {
    const text = askCoachPrompt({ ...modal, title: '   ', date: 'not-a-date' });
    expect(text).toContain('"Untitled workout" on an unknown date');
    expect(text).not.toContain('not-a-date');
  });
});

describe('askCoachDisplay — the line the thread shows', () => {
  it('is "Asked about: <title>, <EEE MMM d>"', () => {
    expect(askCoachDisplay(modal)).toBe('Asked about: Nightly Stretch — Upper, Mon Jun 22');
  });

  it('sanitises the title and falls back on a raw date it cannot parse', () => {
    expect(askCoachDisplay({ ...modal, title: 'A <b>\nB', date: '2026-13' })).toBe('Asked about: A b> B, 2026-13');
  });
});

describe('shouldSendAskCoach — when the sidebar sends', () => {
  const free = { isLoading: false, pendingAction: null, lastSent: null };

  it('sends a fresh request on a free pane', () => {
    expect(shouldSendAskCoach(modal, free)).toBe(true);
  });

  it('waits while a turn is in flight or a confirm card is up', () => {
    expect(shouldSendAskCoach(modal, { ...free, isLoading: true })).toBe(false);
    expect(shouldSendAskCoach(modal, { ...free, pendingAction: { toolName: 'create_event' } })).toBe(false);
  });

  it('never sends the same request object twice (StrictMode, dep re-runs), but a new one for the same session is new', () => {
    expect(shouldSendAskCoach(modal, { ...free, lastSent: modal })).toBe(false);
    expect(shouldSendAskCoach({ ...modal }, { ...free, lastSent: modal })).toBe(true);
  });

  it('does nothing with no request', () => {
    expect(shouldSendAskCoach(null, free)).toBe(false);
  });
});
