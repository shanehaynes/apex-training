import type { HelpSlug } from '../../help/pages.js';

// A tip is one card a user meets the first time they reach a feature: title,
// one or two plain sentences, "Got it", and optionally "Show me how" to a
// help page. Data only, on purpose — the server validates ids against this
// catalog and the iOS app will compile it the way it compiles content.ts.
//
// Copy rules (docs/onboarding/MASTER.md, "Copy rules"): body ≤ 35 words,
// title ≤ 5, one imperative verb in the first sentence, buttons named by
// their on-screen label in bold, no jargon. catalog.test.ts enforces the
// counts.

/** 0 = must-have, 1 = should, 2 = nice. Ties break on catalog order. */
export type TipPriority = 0 | 1 | 2;

export interface TipDefinition {
  /** kebab-case, unique across every feature file; the key in profiles.tips_seen. */
  id: string;
  title: string;
  body: string;
  /** "Show me how" target. Omit when the tip stands on its own. */
  help?: HelpSlug;
  priority: TipPriority;
}
