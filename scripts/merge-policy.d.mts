// Types for merge-policy.mjs, which stays plain JS so merge-babysit.sh can
// run it with bare node. Keep the two in step.

/** A held path rule: `path` ending in `/` holds the whole directory. */
export const HELD: ReadonlyArray<{ path: string; reason: string }>;

/** Held by pattern: files npm or other package managers read wherever they sit. */
export const HELD_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }>;

/** The label a human applies to a PR to override a hold. */
export const GRANT_LABEL: string;

/**
 * The hold message for this change set, or null when it is auto-mergeable.
 * `changed` is the PR's total changed-file count; a mismatch with
 * `paths.length` means the listing is truncated and the verdict is a hold.
 */
export function decide(
  paths: string[],
  labels: string[],
  changed?: number,
  sources?: Record<string, { before: string | null; after: string | null }>,
  diffPaths?: string[],
): string | null;

/** Every path the PR changes, both sides of a rename, from git at its merge base and head; null when git cannot say. */
export function diffPaths(number: unknown, head: unknown): string[] | null;

/** Why a package.json change needs a human, or null when it only moves versions of names already present. */
export function manifestHold(before: string | null, after: string | null): string | null;

/** Why a package-lock.json needs a human, or null when every entry is a registry tarball with an integrity hash. */
export function lockfileHold(before: string | null, after: string | null): string | null;

/** Before/after contents for each content-checked path at the PR's merge base and head; undefined when unreadable. */
export function gatherSources(
  paths: string[],
  number: unknown,
  head: unknown,
): Record<string, { before: string | null; after: string | null }> | undefined;
