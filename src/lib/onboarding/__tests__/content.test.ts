import { describe, expect, it } from 'vitest';
import { CHECKLIST_ITEMS, EXTRA_NOTES, GUIDE_URL, WELCOME_STEPS } from '../content';

// The intro is four cards, then silence (docs/onboarding/MASTER.md, "Intro";
// D-O05). Everything past these four is a tip, so a fifth card is a
// regression. Copy rules: body ≤ 35 words, never "simply" or "just".

const words = (text: string) => text.trim().split(/\s+/).length;

describe('WELCOME_STEPS', () => {
  it('is exactly the four intro cards, in order', () => {
    expect(WELCOME_STEPS.map(s => s.id)).toEqual(['welcome', 'plan', 'log', 'coach']);
  });

  it('keeps every body, web and iOS, at 35 words or fewer', () => {
    for (const step of WELCOME_STEPS) {
      expect(words(step.body), step.id).toBeLessThanOrEqual(35);
      if (step.iosBody !== undefined) expect(words(step.iosBody), `${step.id} (iOS)`).toBeLessThanOrEqual(35);
    }
  });

  it('never says "simply" or "just"', () => {
    for (const step of WELCOME_STEPS) {
      for (const text of [step.title, step.body, step.iosBody ?? '']) {
        expect(text, step.id).not.toMatch(/\b(simply|just)\b/i);
      }
    }
  });

  it('does not depend on a watch provider', () => {
    expect(WELCOME_STEPS.filter(s => s.requiresCoros)).toEqual([]);
  });

  it('links only to Apex-hosted pages', () => {
    for (const step of WELCOME_STEPS) {
      if (step.link) expect(step.link.href, step.id).toMatch(/^\/help(\/|$)/);
    }
    expect(GUIDE_URL).toBe('/help');
  });

  it('gives the coach card the key action and the key help page', () => {
    const coach = WELCOME_STEPS.find(s => s.id === 'coach')!;
    expect(coach.action).toEqual({ label: 'Add key', kind: 'open-profile' });
    expect(coach.link).toEqual({ label: 'Get an API key', href: '/help/get-api-key' });
    const plan = WELCOME_STEPS.find(s => s.id === 'plan')!;
    expect(plan.action).toEqual({ label: 'Copy the starter plan', kind: 'copy-template' });
  });
});

describe('CHECKLIST_ITEMS and EXTRA_NOTES', () => {
  it('keep their ids and notes', () => {
    expect(CHECKLIST_ITEMS.map(i => i.id)).toEqual(['template', 'key', 'goal', 'coros', 'connector']);
    expect(EXTRA_NOTES).toHaveLength(2);
  });

  it('point the key row at the help page', () => {
    expect(CHECKLIST_ITEMS.find(i => i.id === 'key')!.hint).toMatch(/Get an API key/);
  });
});
