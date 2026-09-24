import { describe, expect, it } from 'vitest';
import { TIPS, TIP_IDS, isTipId, tipById } from '../index';
import { HELP_SLUGS } from '../../../help/pages';

// The copy rules for tips (docs/onboarding/MASTER.md), enforced where a lane
// will feel them: a body a phone can show in two lines, a title that fits a
// sheet header, ids that will not collide in profiles.tips_seen, and help
// links that resolve to a page that exists.

const words = (text: string) => text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));

describe('tip catalog', () => {
  it('has unique kebab-case ids', () => {
    expect(new Set(TIP_IDS).size).toBe(TIP_IDS.length);
    for (const id of TIP_IDS) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('keeps every body under 35 words and every title under 6', () => {
    for (const tip of TIPS) {
      expect(words(tip.body).length, `${tip.id} body`).toBeLessThanOrEqual(35);
      expect(words(tip.title).length, `${tip.id} title`).toBeLessThanOrEqual(5);
      expect(tip.body.trim(), `${tip.id} body is empty or TODO`).not.toMatch(/^(TODO)?$/i);
    }
  });

  it('never says "simply" or "just"', () => {
    for (const tip of TIPS) {
      expect(tip.body, tip.id).not.toMatch(/\b(simply|just)\b/i);
    }
  });

  it('links only to help pages that exist', () => {
    for (const tip of TIPS) {
      if ('help' in tip && tip.help) expect(HELP_SLUGS).toContain(tip.help);
    }
  });

  it('round-trips ids', () => {
    expect(isTipId('tracker-first')).toBe(true);
    expect(isTipId('not-a-tip')).toBe(false);
    expect(isTipId(42)).toBe(false);
    expect(tipById('tracker-first').title).toBe('Log as you go');
  });
});
