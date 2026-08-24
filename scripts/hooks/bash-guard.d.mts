// Types for bash-guard.mjs, which stays plain JS so the PreToolUse hook can
// run it with bare node before anything is installed. Keep the two in step.

/** Walk up from dir to the checkout root (first dir owning `.git`); null outside a repo. */
export function checkoutRoot(dir: string): string | null;

/** True when the root's `.git` is a directory (the primary checkout, not a linked worktree). */
export function isPrimaryCheckout(root: string): boolean;

/** The primary checkout owning projectDir — itself, or via a worktree's `.git` file. */
export function primaryRootOf(projectDir: string): string | null;

/** cwd plus any literal `cd` targets in the command; unexpanded variables are skipped. */
export function effectiveDirs(command: string, cwd: string): string[];

/** The block message when the command breaks a CLAUDE.md rule, else null to allow. */
export function decide(command: string, cwd: string, projectDir: string): string | null;
