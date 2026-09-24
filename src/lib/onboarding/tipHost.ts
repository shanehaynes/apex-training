import type { TipId, TipPriority } from './tips/index';

// The arbiter's decisions, pure so they can be tested without a DOM
// (docs/onboarding/MASTER.md, "Tips — catalog + arbiter"). TipHost.tsx owns
// the timing: the 600 ms settle, the one-per-load latch, the deferrals.

/** A tip some mounted component wants shown (see hooks/useTip.ts). */
export interface TipCandidate {
  id: TipId;
  /** Registered with an explicit `when` — the feature decided this is the
   *  moment, which beats a tip that merely rides along with a mount. */
  conditioned: boolean;
}

/** What the arbiter needs of a profile row. */
export interface TipEligibilityProfile {
  is_template_source: boolean;
  onboarding_dismissed_at: string | null;
}

/**
 * Whether this account may see tips at all right now: a loaded profile that
 * is not the template source (Shane's own, set up by definition) and has
 * finished the welcome flow, with the kill switch off.
 */
export function tipsEligible(profile: TipEligibilityProfile | null, killSwitch: boolean): boolean {
  return !!profile && !profile.is_template_source && !!profile.onboarding_dismissed_at && !killSwitch;
}

/**
 * The one tip to show, or null. Unseen candidates only, ordered by priority
 * (0 first), then conditioned before unconditioned, then catalog order. An id
 * the catalog does not know is ignored rather than trusted.
 */
export function pickTip(
  candidates: readonly TipCandidate[],
  seen: ReadonlySet<string>,
  catalog: readonly { id: string; priority: TipPriority }[],
): TipId | null {
  let best: { id: TipId; priority: number; conditioned: boolean; index: number } | null = null;
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    const index = catalog.findIndex(t => t.id === c.id);
    if (index < 0) continue;
    const entry = { id: c.id, priority: catalog[index].priority, conditioned: c.conditioned, index };
    if (!best || beats(entry, best)) best = entry;
  }
  return best?.id ?? null;
}

function beats(
  a: { priority: number; conditioned: boolean; index: number },
  b: { priority: number; conditioned: boolean; index: number },
): boolean {
  if (a.priority !== b.priority) return a.priority < b.priority;
  if (a.conditioned !== b.conditioned) return a.conditioned;
  return a.index < b.index;
}

/** The body's one bit of markup: `**x**` is bold, everything else is text. */
export function tipBodySegments(body: string): { text: string; bold: boolean }[] {
  return body
    .split(/(\*\*[^*]+\*\*)/)
    .filter(part => part !== '')
    .map(part => (/^\*\*[^*]+\*\*$/.test(part)
      ? { text: part.slice(2, -2), bold: true }
      : { text: part, bold: false }));
}
