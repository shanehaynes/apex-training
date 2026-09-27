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
// Briefs are written from templates whose fill-in slots look like {{NAME}} or
// {{NAME: what goes here}}. A brief launched with a slot still unfilled is the
// commonest way a worker ends up without its report schema, so any launch
// whose prompt still holds one is denied — read-only and isolated launches
// included. The pattern is deliberately narrow (upper-case NAME right after
// the braces) so code such as JSX style={{ color: 'red' }}, Handlebars
// {{name}} or Go templates {{.Name}} never trips it.
//
// Protocol. Input: one JSON PreToolUse event on stdin, the shape Claude Code
// sends:
//   { "tool_name": "Agent" | "Task" | "Workflow" | <any other tool>,
//     "tool_input": { "prompt": "<the brief>", "subagent_type": "<type>",
//                     "isolation": "worktree" },   // each field optional
//     "cwd": "<session working directory>" }
// Only Agent/Task launches are checked (Workflow gets a context reminder);
// every other tool_name — or an event with none, e.g. a hand-typed test
// missing that field — is allowed silently. subagent_type defaults to
// general-purpose (a writer).
// Output: deny = exit 2 with the reason on stderr (shown to the model);
// allow = exit 0, optionally with JSON on stdout:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"…"}}
// Internal errors and unparseable stdin allow (fail open): a broken guard
// must not brick every session. Node builtins only, one file — the hook runs
// with bare `node` before anything is installed.
//
// Environment:
//   PARALLEL_AGENTS_GUARD=off        disables the hook (always exit 0).
//   CLAUDE_PROJECT_DIR               the project, for .claude/agents/ lookups
//                                    and the same-repository check; falls
//                                    back to the event's cwd.
//   PARALLEL_AGENTS_TEMP_DIRS        colon-separated directories under which
//                                    a lane path is denied as temporary,
//                                    replacing the default list (/tmp,
//                                    /private/tmp, /var/folders,
//                                    /private/var/folders, os.tmpdir()). Set
//                                    it empty to deny none — tests do, so
//                                    fixture worktrees in mkdtemp dirs count.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
export const ORCHESTRATION_TOOLS = new Set(['Workflow']);

// Built-in agent types that cannot change the working tree.
export const READ_ONLY_TYPES = new Set(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']);
const WRITING_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const SKILL_PATH = '.claude/skills/parallel-agents/SKILL.md';
export const BRIEFS_PATH = '.claude/skills/parallel-agents/references/briefs.md';

// ---------------------------------------------------------------------------
// Checkout topology. A checkout root holds `.git`: a directory (the primary
// checkout), or a file `gitdir: <dir>`. That dir is either
//   <common-dir>/worktrees/<name>  → a linked worktree (A77: any common dir —
//                                    <primary>/.git, a bare repo, a .bare
//                                    layout, a --separate-git-dir), or
//   a common dir itself            → the primary checkout of a .bare or
//                                    --separate-git-dir layout.
// A common dir that belongs to a submodule makes either a submodule (A38),
// and a gitdir that does not exist is stale (A81). The primary of a common
// dir is its parent, as in the contract: `$(git rev-parse --git-common-dir)/..`.
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

export function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const readText = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// A submodule's git dir lives in <super>/.git/modules/<name>; elsewhere
// (a super-repo with a separate git dir), under …/modules/… with the
// submodule's core.worktree set.
function isSubmoduleGitDir(dir) {
  if (dir.includes(`${sep}.git${sep}modules${sep}`)) return true;
  if (!dir.includes(`${sep}modules${sep}`)) return false;
  return /^\s*worktree\s*=/m.test(readText(join(dir, 'config')) ?? '');
}

/**
 * What kind of checkout `root` (a directory holding `.git`) is.
 * @returns {{ kind: 'primary'|'linked'|'submodule'|'stale'|'foreign'|'none',
 *   gitdir?: string, commonDir?: string, primary?: string }}
 */
export function checkoutInfo(root) {
  const dotgit = join(root, '.git');
  let st;
  try {
    st = statSync(dotgit);
  } catch {
    return { kind: 'none' };
  }
  if (st.isDirectory()) return { kind: 'primary', gitdir: dotgit, commonDir: realpathOr(dotgit), primary: root };
  const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(readText(dotgit) ?? '');
  if (!m) return { kind: 'foreign' };
  const raw = resolve(root, m[1]);
  if (!isDir(raw)) return { kind: 'stale', gitdir: raw };
  const gitdir = realpathOr(raw);
  const commonRel = readText(join(gitdir, 'commondir'));
  if (commonRel === null) {
    // The .git file points straight at a common dir.
    if (isSubmoduleGitDir(gitdir)) return { kind: 'submodule', gitdir, commonDir: gitdir };
    if (!existsSync(join(gitdir, 'HEAD'))) return { kind: 'foreign', gitdir };
    return { kind: 'primary', gitdir, commonDir: gitdir, primary: root };
  }
  const commonDir = realpathOr(resolve(gitdir, commonRel.trim()));
  if (basename(dirname(gitdir)) !== 'worktrees' || realpathOr(dirname(dirname(gitdir))) !== commonDir) {
    return { kind: 'foreign', gitdir, commonDir };
  }
  if (isSubmoduleGitDir(commonDir)) return { kind: 'submodule', gitdir, commonDir };
  return { kind: 'linked', gitdir, commonDir, primary: dirname(commonDir) };
}

export function isLinkedWorktree(root) {
  return checkoutInfo(root).kind === 'linked';
}

export function primaryRootOf(dir) {
  const root = checkoutRoot(dir);
  if (!root) return null;
  const info = checkoutInfo(root);
  return info.kind === 'primary' || info.kind === 'linked' ? info.primary : null;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

// A tool list item: `*`, a tool name, or a scoped tool like `Bash(git:*)`.
const TOOL_ITEM = /^(?:\*|[A-Za-z_][\w.-]*(?:\([^()]*\))?)$/;
const unquote = (v) => {
  const q = /^(['"])(.*)\1$/.exec(v);
  return q ? q[2] : v;
};
const stripComment = (v) => v.replace(/(^|[ \t])#.*$/, '');

// Items → "A, B" or null when any item is not a tool name (fail closed).
function toolList(items) {
  const out = [];
  for (const raw of items) {
    const item = unquote(raw.trim()).trim();
    if (item === '') continue;
    if (!TOOL_ITEM.test(item)) return null;
    out.push(item);
  }
  return out.join(', ');
}

// A project or user agent definition's `tools:` field, as "A, B, C".
// null = every tool: no field, an empty field, or anything the hook cannot
// parse — block scalars, flow lists spanning lines, multi-line plain
// scalars, items that are not tool names (A75, fail closed). Parsed forms:
// `tools: A, B`, `tools: "A, B"`, `tools: [A, B]`, and a block list (A41).
export function agentTools(type, projectDir, home = process.env.HOME ?? '') {
  for (const base of [join(projectDir, '.claude', 'agents'), join(home, '.claude', 'agents')]) {
    const file = join(base, `${type}.md`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!front) return null;
    const lines = front[1].split(/\r?\n/);
    const at = lines.findIndex((l) => /^tools[ \t]*:/.test(l));
    if (at === -1) return null;
    const inline = stripComment(lines[at].replace(/^tools[ \t]*:/, '')).trim();
    const next = lines.slice(at + 1).find((l) => l.trim() !== '');
    const continued = next !== undefined && /^[ \t]/.test(next) && !/^[ \t]*-/.test(next);
    if (inline) {
      if (continued || /^[|>]/.test(inline)) return null;
      if (inline.startsWith('[')) return inline.endsWith(']') ? toolList(inline.slice(1, -1).split(',')) : null;
      return toolList(unquote(inline).split(','));
    }
    const items = [];
    for (let k = at + 1; k < lines.length; k++) {
      const item = /^[ \t]*-[ \t]*(.*)$/.exec(lines[k]);
      if (item) items.push(stripComment(item[1]));
      else if (lines[k].trim() === '') continue;
      else if (/^[ \t]/.test(lines[k])) return null; // continuation of an item
      else break;
    }
    return items.length ? toolList(items) : null;
  }
  return undefined; // unknown type
}

export function canWrite(type, projectDir, home) {
  if (READ_ONLY_TYPES.has(type)) return false;
  const tools = agentTools(type, projectDir, home);
  if (tools === undefined || tools === null) return true; // unknown, all tools, or unparseable
  return tools
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || WRITING_TOOLS.has(t.replace(/\(.*$/, '')));
}

// ---------------------------------------------------------------------------
// The lane declaration
// ---------------------------------------------------------------------------

// `Lane: …` on its own line. Accepted prefixes: indentation, a list bullet
// (- + *), a numbered item (1. or 1)), a heading (# to ######, with an
// optional closing #-run), and emphasis around the label (**Lane:**,
// **Lane**:, or emphasis that closes at the end of the line: **Lane: /wt**).
// Lines inside fenced code blocks (``` or ~~~) and blockquotes (>) are
// examples, not declarations (A39); a ``` line with another backtick after
// it is inline code, not a fence (A80).
//
// For a path value: commentary after " — " or " -- " is dropped, then
// surrounding backticks and *balanced* emphasis (a lone trailing _ or * is
// part of the path), a trailing parenthetical separated by any whitespace
// (NBSP included), and one sentence-ending period — `Lane: /abs/wt.` → /abs/wt,
// but /a/.. keeps its dots. For read-only and none, wrappers around the
// keyword are ignored: `read-only` (reviews), **none** — why.
//
// Hand-written scanners, not backtracking regexes: everything here is linear
// in the prompt's length (A42, A79) — a brief is untrusted-size input on
// every launch.

const isSpace = (c) => {
  if (c === undefined) return false;
  if (c === ' ' || c === '\t' || c === ' ') return true;
  const code = c.charCodeAt(0);
  return (code < 33 || code > 126) && /\s/.test(c);
};
const isHSpace = (c) => c === ' ' || c === '\t' || c === ' ';
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isEmph = (c) => c === '*' || c === '_';
const isWrap = (c) => c === '`' || c === '*' || c === '_';

// The raw value after `Lane:` on one line, or null if the line is not a
// Lane line.
function laneValueOf(line) {
  const n = line.length;
  let i = 0;
  const skipH = () => {
    while (i < n && isHSpace(line[i])) i++;
  };
  skipH();
  let heading = false;
  if (line[i] === '#') {
    let j = i;
    while (j < n && line[j] === '#' && j - i < 7) j++;
    if (j - i > 6 || !isHSpace(line[j])) return null;
    heading = true;
    i = j;
    skipH();
  } else if (isDigit(line[i])) {
    let j = i;
    while (j < n && isDigit(line[j]) && j - i < 10) j++;
    if ((line[j] !== '.' && line[j] !== ')') || !isHSpace(line[j + 1])) return null;
    i = j + 1;
    skipH();
  } else if ((line[i] === '-' || line[i] === '+' || line[i] === '*') && isHSpace(line[i + 1])) {
    i += 1;
    skipH();
  }
  const emph = () => {
    const at = i;
    for (let e = 0; e < 3 && i < n && isEmph(line[i]); e++) i++;
    return i - at;
  };
  const opened = emph();
  const openCh = line[i - 1];
  if (line.slice(i, i + 4).toLowerCase() !== 'lane') return null;
  i += 4;
  const closedBefore = emph();
  if (line[i] !== ':') return null;
  i++;
  const closedAfter = emph();
  let s = i;
  let t = n;
  const trim = () => {
    while (s < t && isSpace(line[s])) s++;
    while (t > s && isSpace(line[t - 1])) t--;
  };
  trim();
  if (heading) {
    let q = t;
    while (q > s && line[q - 1] === '#') q--;
    if (q < t && q > s && isSpace(line[q - 1])) {
      t = q;
      trim();
    }
  }
  const open = opened - closedBefore - closedAfter; // emphasis still open at the value
  if (open > 0) {
    let k = 0;
    while (k < open && t - 1 - k > s && line[t - 1 - k] === openCh) k++;
    if (k === open) {
      t -= k;
      trim();
    }
  }
  return s < t ? line.slice(s, t) : null;
}

// Strip wrappers (backticks, balanced emphasis) and, if `parens`, trailing
// whitespace-separated parentheticals, repeatedly. Linear: every character
// examined is either removed or ends the loop — the wrapper runs are counted
// pairwise, never the long side alone (A79).
function unwrap(v, parens) {
  let s = 0;
  let t = v.length;
  for (;;) {
    const s0 = s;
    const t0 = t;
    const c = v[s];
    if (t - s >= 2 && isWrap(c) && v[t - 1] === c) {
      let k = 0;
      while (s + k < t - 1 - k && v[s + k] === c && v[t - 1 - k] === c) k++;
      if (s + k >= t - 1 - k && v[s + k] === c) return ''; // nothing but wrapper characters
      s += k;
      t -= k;
    }
    if (parens && t - s >= 2 && v[t - 1] === ')') {
      const open = v.lastIndexOf('(', t - 2);
      if (open > s && isSpace(v[open - 1]) && v.indexOf(')', open) === t - 1) t = open;
      else if (s === s0 && t === t0) return v.slice(s, t).trim();
    }
    while (s < t && isSpace(v[s])) s++;
    while (t > s && isSpace(v[t - 1])) t--;
    if (s === s0 && t === t0) return v.slice(s, t);
  }
}

// " — " or " -- " after the path starts commentary (A83).
function dropCommentary(v) {
  for (let i = 1; i < v.length - 2; i++) {
    if (!isSpace(v[i - 1])) continue;
    if (v[i] === '—' && isSpace(v[i + 1])) return v.slice(0, i);
    if (v[i] === '-' && v[i + 1] === '-' && isSpace(v[i + 2])) return v.slice(0, i);
  }
  return v;
}

function laneOf(value) {
  let i = 0;
  while (i < value.length && isWrap(value[i])) i++;
  if (/^read[- ]?only\b/i.test(value.slice(i, i + 10))) return { kind: 'read-only' };
  if (/^none\b/i.test(value.slice(i, i + 5))) {
    let j = i + 4;
    while (j < value.length && isWrap(value[j])) j++;
    while (j < value.length && isSpace(value[j])) j++;
    const d = j;
    while (j < value.length && '—–:-'.includes(value[j])) j++;
    if (j > d) while (j < value.length && isSpace(value[j])) j++;
    let t = value.length;
    for (let k = 0; k < i && t > j && isWrap(value[t - 1]); k++) t--;
    return { kind: 'none', reason: value.slice(j, t).trim() };
  }
  let path = unwrap(dropCommentary(value), true);
  if (path.length > 1 && path.endsWith('.') && path[path.length - 2] !== '.' && path[path.length - 2] !== '/') {
    path = unwrap(path.slice(0, -1), true);
  }
  return { kind: 'path', path };
}

/**
 * Every Lane declaration outside fenced code and blockquotes, in order.
 * @returns {{ line: string, lineNo: number, lane: object }[]}
 */
export function parseLanes(prompt) {
  const out = [];
  let fence = null; // { ch, len }
  const lines = String(prompt ?? '').split('\n');
  for (let no = 0; no < lines.length; no++) {
    let raw = lines[no];
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    let i = 0;
    while (i < raw.length && isHSpace(raw[i])) i++;
    const ch = raw[i];
    if (ch === '`' || ch === '~') {
      let j = i;
      while (raw[j] === ch) j++;
      const len = j - i;
      if (len >= 3) {
        if (fence) {
          if (fence.ch === ch && len >= fence.len && raw.slice(j).trim() === '') fence = null;
          continue;
        }
        if (!(ch === '`' && raw.includes('`', j))) {
          fence = { ch, len };
          continue;
        }
        // "``` npm test ```" is inline code, not a fence (A80).
      }
    }
    if (fence || ch === '>') continue;
    const value = laneValueOf(raw);
    if (value !== null) out.push({ line: raw.trim(), lineNo: no + 1, lane: laneOf(value) });
  }
  return out;
}

// The effective Lane declaration: the first one outside fences and quotes.
export function parseLane(prompt) {
  const all = parseLanes(prompt);
  return all.length ? all[0].lane : null;
}

// ---------------------------------------------------------------------------
// Unfilled template slots
// ---------------------------------------------------------------------------

// {{NAME}} or {{NAME: description}}, NAME = [A-Z][A-Z0-9_]*, nothing between
// the braces and NAME, the description on one line. Not preceded or followed
// by a third brace, so Handlebars' raw {{{…}}} is left alone.
const PLACEHOLDER = /(?<!\{)\{\{([A-Z][A-Z0-9_]*)(?::[^{}\r\n]*)?\}\}(?!\})/g;
export const DEFAULT_TEMP_DIRS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()];
export const MAX_LISTED_SLOTS = 5;

/** Distinct unfilled slot NAMEs in order of first appearance. */
export function findPlaceholders(prompt) {
  const names = new Set();
  for (const m of String(prompt ?? '').matchAll(PLACEHOLDER)) names.add(m[1]);
  return [...names];
}

function msg(lines) {
  return lines.join('\n');
}

// No line of any message may itself read as a Lane line or a slot (A36,
// A76): a brief that relays a deny must not be denied for it. So the
// examples below start with a label, never with "Lane:".
const HOW_TO_COMPLY = [
  'Declare where this worker runs with one line in the brief that starts with "Lane:" —',
  '  a worktree:  Lane: <absolute path of a worktree cut for this lane>   (lane.sh new <branch> "<files it owns>")',
  '  read-only:   Lane: read-only   (it will not change files, build, or start servers)',
  '  no lane:     Lane: none — <reason>   (explicit opt-out, with the reason)',
  'or launch with isolation: "worktree".',
  `Brief templates: ${BRIEFS_PATH}.`,
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
        `Brief and report templates: ${BRIEFS_PATH}.`,
      ]),
    };
  }
  if (!SUBAGENT_TOOLS.has(tool)) return { action: 'allow' };

  const type = input.subagent_type || 'general-purpose';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  // Unfilled slots first: a half-filled brief is wrong whatever its lane says.
  // No message of this hook may itself contain a slot (A36): a brief that
  // relays a deny must not be denied for it. Hence names, not braces.
  const slots = findPlaceholders(prompt);
  if (slots.length) {
    const listed = slots.slice(0, MAX_LISTED_SLOTS).join(', ');
    const more = slots.length > MAX_LISTED_SLOTS ? ` (and ${slots.length - MAX_LISTED_SLOTS} more)` : '';
    return {
      action: 'deny',
      reason: msg([
        `Blocked: the brief still has unfilled template slots: ${listed}${more}.`,
        '(A slot is an upper-case NAME in double braces, optionally followed by ": description".)',
        `Fill each one with its real value before launching — templates: ${BRIEFS_PATH}.`,
        'If the braces are meant literally (quoted code, config, or this message), put spaces inside: {{ NAME }}.',
        'Never paste a secret into a brief to fill one — refer to where the worker can read it instead.',
      ]),
    };
  }

  const declared = parseLanes(prompt);
  if (new Set(declared.map((d) => laneKey(d.lane))).size > 1) {
    const shown = declared
      .slice(0, 5)
      .map((d) => `  line ${d.lineNo}: ${d.line.length > 200 ? `${d.line.slice(0, 200)}…` : d.line}`);
    return {
      action: 'deny',
      reason: msg([
        'Blocked: the brief declares its lane more than once, and the declarations disagree:',
        ...shown,
        'Keep one Lane line; put examples inside a fenced code block or a > quote, where they are ignored.',
        ...HOW_TO_COMPLY,
      ]),
    };
  }

  const lane = declared.length ? declared[0].lane : null;
  const writer = canWrite(type, projectDir, home);
  const schemaMissing = lane?.kind === 'path' && !prompt.includes('GATE TOUCHED') && !prompt.includes('FINDINGS:');
  // A88: a read-only worker has no branch and no worktree to check.
  const reminder = (extra, readOnly = false) =>
    msg([
      `parallel-agents (${SKILL_PATH}): ${extra}`,
      readOnly
        ? 'When it reports: check its findings against the sources it cites, and carry its NOT VERIFIED list forward.'
        : 'When it reports: check the SHA is on the remote, the worktree is clean, and carry its NOT VERIFIED list forward.',
      `Brief templates: ${BRIEFS_PATH}.`,
      // Amendment A4: an additional line, never a replacement.
      ...(schemaMissing
        ? [`The brief has no report schema (neither "GATE TOUCHED" nor "FINDINGS:") — paste the lane report schema from ${BRIEFS_PATH}.`]
        : []),
    ]);

  // A declared path lane is checked whatever else the launch says (A37).
  let checked = null;
  if (lane?.kind === 'path') {
    checked = checkLanePath(lane.path, opts.tempDirs ?? DEFAULT_TEMP_DIRS, projectDir);
    if (checked.deny) return checked.deny;
  }

  if (input.isolation === 'worktree') {
    const also = checked ? ` (declared lane ${checked.root})` : '';
    return {
      action: 'allow',
      context: withForeign(reminder(`isolated worktree lane${also} — you own the PR, the merge and the combine check.`), checked),
    };
  }

  if (!lane) {
    if (!writer) return { action: 'allow', context: reminder('read-only lane — keep its scope disjoint from sibling lanes.', true) };
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
    return { action: 'allow', context: reminder('declared read-only — the brief should also tell it not to edit, build, or start servers.', true) };
  }

  if (lane.kind === 'none') {
    if (lane.reason.length < 8) {
      return { action: 'deny', reason: msg(['Blocked: "Lane: none" needs a reason after it, e.g. "Lane: none — runs the merge loop from the primary checkout".', ...HOW_TO_COMPLY]) };
    }
    return { action: 'allow', context: reminder(`no lane (${lane.reason}).`) };
  }

  return {
    action: 'allow',
    context: withForeign(
      reminder(
        `lane ${checked.root}${checked.underCanonical ? '' : ' (outside .claude/worktrees/ — other sessions may not find it)'}. ` +
          'The brief should name the files it owns, its gate commands, and the report schema.',
      ),
      checked,
    ),
  };
}

// A82: an extra line, never a deny.
function withForeign(context, checked) {
  if (!checked?.foreign) return context;
  return msg([
    context,
    `Note: this lane is a worktree of a different repository (${checked.primary}) than the project (${checked.foreign}) — make sure that is intended.`,
  ]);
}

// Two Lane lines agree when they name the same checkout (A78).
function laneKey(l) {
  if (l.kind !== 'path') return l.kind;
  if (!isAbsolute(l.path)) return `rel:${resolve('/', l.path)}`;
  const real = realpathOr(l.path);
  return `path:${checkoutRoot(real) ?? real}`;
}

const isUnder = (dir, p) => {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// A lane path: absolute, existing, inside a linked worktree of some primary
// (not the primary itself, not a submodule), not under a temp directory.
// Symlinks are resolved on both sides before comparing (A40).
function checkLanePath(p, tempDirs, projectDir) {
  const deny = (why) => ({
    deny: {
      action: 'deny',
      reason: msg([`Blocked: Lane "${p}" ${why}`, `See ${SKILL_PATH}, step 3 (Provision environments).`, ...HOW_TO_COMPLY]),
    },
  });
  if (!isAbsolute(p)) return deny('is not an absolute path — a subagent\'s shell may start anywhere.');
  if (!existsSync(p)) return deny('does not exist — create the worktree before launching the worker.');
  const root = checkoutRoot(realpathOr(p));
  if (!root) return deny('is not inside a git checkout.');
  const info = checkoutInfo(root);
  switch (info.kind) {
    case 'linked':
      break;
    case 'primary':
      return deny('is the primary checkout, which stays on the default branch and clean — cut a worktree.');
    case 'submodule':
      return deny(`is inside a git submodule (${root}), not a linked worktree — cut a worktree of the project instead.`);
    case 'stale':
      return deny(
        `is in ${root}, whose .git file points at ${info.gitdir}, which does not exist — a stale or hand-written worktree. ` +
          'Run git worktree prune and cut a fresh one.',
      );
    default:
      return deny(`is in ${root}, which is not a linked worktree (its .git file does not point at <common-dir>/worktrees/<name>).`);
  }
  const temps = [];
  for (const t of tempDirs) if (t) temps.push(resolve(t), realpathOr(t));
  if (temps.some((t) => isUnder(t, root))) {
    return deny('lives under a temp directory — it will not survive a reboot and other sessions cannot find it. Use <primary>/.claude/worktrees/.');
  }
  let foreign = null;
  const projectRoot = projectDir ? checkoutRoot(realpathOr(projectDir)) : null;
  const project = projectRoot ? checkoutInfo(projectRoot) : null;
  if (project?.commonDir && project.commonDir !== info.commonDir) foreign = project.primary ?? projectRoot;
  return {
    root,
    primary: info.primary,
    foreign,
    underCanonical: isUnder(join(info.primary, '.claude', 'worktrees'), root),
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

// Run as a script, however reached: node resolves the main module through
// symlinks (so import.meta.url is a realpath) while argv[1] is the path as
// typed, so compare realpaths (A35).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(main());
}
