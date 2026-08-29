// The single source of truth for which legal documents are in force.
// legal/terms-v1.md, legal/privacy-v1.md, the acceptance handler
// (api/_lib/handlers/termsAcceptance.ts), the requireUser gate, and the
// re-acceptance modal all read from here — one bump moves everything
// together, and src/lib/legal/__tests__/versions.test.ts pins these against
// the documents' own frontmatter so the two can never disagree about what
// was accepted.
//
// DEPENDENCY-FREE ON PURPOSE: the API runtime imports this file, and its
// import surface is restricted (see the warning in api/chat.ts). Same
// posture as src/lib/coach/model.ts.
//
// BUMPING A VERSION IS A USER-VISIBLE EVENT: every existing user is blocked
// behind the re-acceptance modal on their next load until they accept again.
// Bump for substantive changes, not typo fixes.

export const TERMS_VERSION = 'terms-v1';
export const PRIVACY_VERSION = 'privacy-v1';

/** ISO date the current versions took effect; rendered in the page header. */
export const LEGAL_EFFECTIVE_DATE = '2026-08-29';

/** The document slugs, in the order the acceptance checkbox lists them. */
export const LEGAL_DOCUMENTS = [
  { slug: 'terms', path: '/terms', title: 'Terms of Service', version: TERMS_VERSION },
  { slug: 'privacy', path: '/privacy', title: 'Privacy Policy', version: PRIVACY_VERSION },
] as const;

export type LegalSlug = (typeof LEGAL_DOCUMENTS)[number]['slug'];

/** True when a stored acceptance is missing or predates the current versions. */
export function needsAcceptance(
  accepted: { termsVersion?: string | null; privacyVersion?: string | null } | null | undefined,
): boolean {
  if (!accepted) return true;
  return accepted.termsVersion !== TERMS_VERSION || accepted.privacyVersion !== PRIVACY_VERSION;
}
