// Types for merge-policy.mjs, which stays plain JS so merge-babysit.sh can
// run it with bare node. Keep the two in step.

/** A held path rule: `path` ending in `/` holds the whole directory. */
export const HELD: ReadonlyArray<{ path: string; reason: string }>;

/** The label a human applies to a PR to override a hold. */
export const GRANT_LABEL: string;

/**
 * The hold message for this change set, or null when it is auto-mergeable.
 * `changed` is the PR's total changed-file count; a mismatch with
 * `paths.length` means the listing is truncated and the verdict is a hold.
 */
export function decide(paths: string[], labels: string[], changed?: number): string | null;
