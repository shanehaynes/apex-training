#!/usr/bin/env node
// PreToolUse hook for subagent launches (the Agent tool, formerly Task): the
// mechanical form of the parallel-agents skill. A skill triggers from its
// description, which is probabilistic; this makes the skill's one
// load-bearing decision — where does this worker run? — impossible to skip.
//
// Every launch of a subagent that can write (Bash, Edit, Write…) must declare
// its lane in the brief, on a line of its own:
//
//   Lane: /abs/path/to/<primary>/.claude/worktrees/<branch>   a linked worktree
//   Lane: read-only                                           light path
//   Lane: none — <why this worker needs no lane>              explicit opt-out
//
// or launch with `isolation: "worktree"`, where the harness makes one. A
// launch with none of these is denied with a message that says how to comply,
// which sends the orchestrator to the skill. Agent types that cannot write
// (Explore, Plan, and project agents whose `tools:` holds no writing tool)
// need no declaration. Launches that pass get a short reminder of what the
// skill expects next.
//
// Why a declaration and not inference: the hook cannot know what a brief
// intends, but it can make the orchestrator decide in writing, and check the
// part that is checkable — a lane path must be a real linked worktree, not
// the primary checkout, not /tmp, not a directory that does not exist.
//
// Protocol: deny = exit 2 with the reason on stderr (shown to the model);
// allow = exit 0, optionally with JSON on stdout carrying additionalContext.
// Internal errors allow (fail open): a broken guard must not brick every
// session. Node builtins only, one file — the hook runs with bare `node`
// before anything is installed. PARALLEL_AGENTS_GUARD=off disables it.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
export const ORCHESTRATION_TOOLS = new Set(['Workflow']);

// Built-in agent types that cannot change the working tree.
export const READ_ONLY_TYPES = new Set(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']);
const WRITING_TOOLS = /\b(Bash|Edit|Write|MultiEdit|NotebookEdit|\*)\b/;

export const SKILL_PATH = '.claude/skills/parallel-agents/SKILL.md';

// ---------------------------------------------------------------------------
// Checkout topology (same rules as the skill's scripts: the primary checkout
// owns a .git directory; a linked worktree has a .git file)
// ---------------------------------------------------------------------------

export function checkoutRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

export function isLinkedWorktree(root) {
  try {
    return statSync(join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

export function primaryRootOf(dir) {
  const root = checkoutRoot(dir);
  if (!root) return null;
  if (!isLinkedWorktree(root)) return root;
  // `.git` file: "gitdir: <primary>/.git/worktrees/<name>"
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, '.git'), 'utf8'));
  if (!m) return null;
  const gitdir = resolve(root, m[1].trim());
  const idx = gitdir.lastIndexOf(`${sep}.git${sep}worktrees${sep}`);
  return idx === -1 ? null : gitdir.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

// A project or user agent definition's `tools:` line. No line = every tool.
export function agentTools(type, projectDir, home = process.env.HOME ?? '') {
  for (const base of [join(projectDir, '.claude', 'agents'), join(home, '.claude', 'agents')]) {
    const file = join(base, `${type}.md`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    const line = front && /^tools:\s*(.*)$/m.exec(front[1]);
    return line ? line[1] : null;
  }
  return undefined; // unknown type
}

export function canWrite(type, projectDir, home) {
  if (READ_ONLY_TYPES.has(type)) return false;
  const tools = agentTools(type, projectDir, home);
  if (tools === undefined || tools === null) return true; // unknown or all tools
  return WRITING_TOOLS.test(tools);
}

// ---------------------------------------------------------------------------
// The lane declaration
// ---------------------------------------------------------------------------

// `Lane: …` on its own line; tolerates markdown emphasis and list bullets.
export function parseLane(prompt) {
  const m = /^[ \t>*_-]*\**Lane\**:\**[ \t]*(.+?)[ \t]*$/im.exec(prompt ?? '');
  if (!m) return null;
  const value = m[1].replace(/^[`*_]+|[`*_]+$/g, '').trim();
  if (/^read[- ]?only\b/i.test(value)) return { kind: 'read-only' };
  const none = /^none\b\s*(?:[—–:-]+\s*)?(.*)$/i.exec(value);
  if (none) return { kind: 'none', reason: none[1].trim() };
  return { kind: 'path', path: value };
}

function msg(lines) {
  return lines.join('\n');
}

const HOW_TO_COMPLY = [
  'Declare where this worker runs, on its own line in the brief:',
  '  Lane: <absolute path of a worktree cut for this lane>   (lane.sh new <branch> "<files it owns>")',
  '  Lane: read-only                                          (it will not change files, build, or start servers)',
  '  Lane: none — <reason>                                    (explicit opt-out, with the reason)',
  'or launch with isolation: "worktree".',
];

/**
 * Decide on one PreToolUse event.
 * @returns {{ action: 'allow' | 'deny', reason?: string, context?: string }}
 */
export function decide(event, opts = {}) {
  const projectDir = opts.projectDir ?? event.cwd ?? process.cwd();
  const home = opts.home;
  const tool = event.tool_name;
  const input = event.tool_input ?? {};

  if (ORCHESTRATION_TOOLS.has(tool)) {
    return {
      action: 'allow',
      context: msg([
        `parallel-agents: this workflow fans out agents — follow ${SKILL_PATH}.`,
        'Every agent() that writes needs its own worktree (created by you, named in its prompt as "Lane: <path>"),',
        'a structured schema for its report, and a combine check before anything merges.',
      ]),
    };
  }
  if (!SUBAGENT_TOOLS.has(tool)) return { action: 'allow' };

  const type = input.subagent_type || 'general-purpose';
  const lane = parseLane(input.prompt);
  const writer = canWrite(type, projectDir, home);
  const reminder = (extra) =>
    msg([
      `parallel-agents (${SKILL_PATH}): ${extra}`,
      'When it reports: check the SHA is on the remote, the worktree is clean, and carry its NOT VERIFIED list forward.',
    ]);

  if (input.isolation === 'worktree') {
    return { action: 'allow', context: reminder('isolated worktree lane — you own the PR, the merge and the combine check.') };
  }

  if (!lane) {
    if (!writer) return { action: 'allow', context: reminder('read-only lane — keep its scope disjoint from sibling lanes.') };
    return {
      action: 'deny',
      reason: msg([
        `Blocked: a "${type}" subagent can change files, and its brief does not say where it runs.`,
        `Read ${SKILL_PATH} (parallel-agents) before launching subagents.`,
        ...HOW_TO_COMPLY,
      ]),
    };
  }

  if (lane.kind === 'read-only') {
    return { action: 'allow', context: reminder('declared read-only — the brief should also tell it not to edit, build, or start servers.') };
  }

  if (lane.kind === 'none') {
    if (lane.reason.length < 8) {
      return { action: 'deny', reason: msg(['Blocked: "Lane: none" needs a reason after it, e.g. "Lane: none — runs the merge loop from the primary checkout".', ...HOW_TO_COMPLY]) };
    }
    return { action: 'allow', context: reminder(`no lane (${lane.reason}).`) };
  }

  // A lane path: absolute, existing, a linked worktree, not the primary.
  const p = lane.path;
  const deny = (why) => ({
    action: 'deny',
    reason: msg([`Blocked: Lane "${p}" ${why}`, `See ${SKILL_PATH}, step 3 (Provision environments).`, ...HOW_TO_COMPLY]),
  });
  if (!isAbsolute(p)) return deny('is not an absolute path — a subagent\'s shell may start anywhere.');
  if (!existsSync(p)) return deny('does not exist — create the worktree before launching the worker.');
  const root = checkoutRoot(p);
  if (!root) return deny('is not inside a git checkout.');
  if (!isLinkedWorktree(root)) return deny('is the primary checkout, which stays on the default branch and clean — cut a worktree.');
  const primary = primaryRootOf(root);
  const tempDirs = opts.tempDirs ?? ['/tmp', '/private/tmp', '/var/folders', tmpdir()];
  if (tempDirs.some((t) => t && !relative(t, root).startsWith('..'))) return deny('lives under a temp directory — it will not survive a reboot and other sessions cannot find it. Use <primary>/.claude/worktrees/.');
  const underCanonical = primary && !relative(join(primary, '.claude', 'worktrees'), root).startsWith('..');
  return {
    action: 'allow',
    context: reminder(
      `lane ${root}${underCanonical ? '' : ' (outside .claude/worktrees/ — other sessions may not find it)'}. ` +
        'The brief should name the files it owns, its gate commands, and the report schema.',
    ),
  };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

function main() {
  if ((process.env.PARALLEL_AGENTS_GUARD ?? '').toLowerCase() === 'off') return 0;
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  try {
    const envTemp = process.env.PARALLEL_AGENTS_TEMP_DIRS; // colon-separated; tests set it
    const verdict = decide(event, {
      projectDir: process.env.CLAUDE_PROJECT_DIR || event.cwd,
      tempDirs: envTemp === undefined ? undefined : envTemp.split(':').filter(Boolean),
    });
    if (verdict.action === 'deny') {
      process.stderr.write(`${verdict.reason}\n`);
      return 2;
    }
    if (verdict.context) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: verdict.context } }),
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`agent-guard: internal error, allowing: ${err?.message ?? err}\n`);
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
