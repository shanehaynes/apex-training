// Types for bash-guard.mjs, which stays plain JS so the PreToolUse hook can
// run it with bare node before anything is installed. Keep the two in step.

/** Walk up from dir to the checkout root (first dir owning `.git`); null outside a repo. */
export function checkoutRoot(dir: string): string | null;

/** True when the root's `.git` is a directory (the primary checkout, not a linked worktree). */
export function isPrimaryCheckout(root: string): boolean;

/** The primary checkout owning projectDir — itself, or via a worktree's `.git` file. */
export function primaryRootOf(projectDir: string): string | null;

/** cwd plus any literal `cd`/`pushd` target the shell would run; unexpanded variables are skipped. */
export function effectiveDirs(command: string, cwd: string): string[];

/** The block message when the command breaks a CLAUDE.md rule, else null to allow. */
export function decide(command: string, cwd: string, projectDir: string): string | null;

/** The pre-parser regex rules, kept as the fallback when a command will not tokenize. */
export function legacyDecide(command: string, cwd: string, projectDir: string): string | null;

/** Thrown for input the tokenizer will not guess at; sends `decide` to `legacyDecide`. */
export class ShellParseError extends Error {
  constructor(message: string);
}

/** One argv word, with what quoting and expansion did to it. */
export interface ShellWord {
  /** The literal text, after quote removal; expansions contribute nothing. */
  value: string;
  /** Any part of the word came from quotes or a backslash escape. */
  quoted: boolean;
  /** The word contains an expansion whose value we refuse to guess at. */
  dynamic: boolean;
}

/** A `NAME=value` prefix on one command. */
export interface ShellAssignment {
  name: string;
  value: string;
  quoted: boolean;
  dynamic: boolean;
}

/** A heredoc feeding one command's stdin. */
export interface ShellHeredoc {
  /** The delimiter word, after quote removal. */
  delim: string;
  /** `<<'EOF'` rather than `<<EOF` — the body is literal, so it is data. */
  quotedDelim: boolean;
  /** `<<-` strips leading tabs from the body and the delimiter line. */
  strip: boolean;
  /** The body text, newline-terminated; never appears among `words`. */
  body: string;
  /** Nesting depth of the command the heredoc feeds. */
  depth: number;
}

/** One simple command: what the shell runs between two separators. */
export interface SimpleCommand {
  /** argv, command name first. Heredoc bodies and redirect targets are not here. */
  words: ShellWord[];
  /** `NAME=value` prefixes on this command only. */
  env: ShellAssignment[];
  /** Filenames named by `>`, `>>`, `<` and friends. */
  redirects: ShellWord[];
  /** `<<`/`<<-` bodies fed to this command's stdin. */
  heredocs: ShellHeredoc[];
  /** `<<<` operand, if any. */
  hereString: ShellWord | null;
  /** The upstream side of a pipeline, so `echo … | bash` can be followed. */
  pipeFrom: SimpleCommand | null;
  /** 0 at the top level; one deeper inside `$(…)`, backquotes, a subshell, or parsed code. */
  depth: number;
}

/** Every simple command the shell would run, flattened, innermost included. */
export function parseShell(command: string): SimpleCommand[];
