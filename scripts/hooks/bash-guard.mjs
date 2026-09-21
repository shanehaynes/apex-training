#!/usr/bin/env node
// PreToolUse hook for the Bash tool (wired in .claude/settings.json): the
// mechanical form of three CLAUDE.md rules that used to be prose only.
//
//   1. Never kill vite by name — `pkill -f vite`, or a `kill` handed every PID
//      `pgrep`/`pidof` can find for it. That is every session's dev server.
//   2. Never throw work away without looking first — the working tree, the
//      shared stash stack or an unmerged branch may hold another session's
//      only copy of its work. `git reset --hard`, `git clean -f`,
//      `git checkout -- <path>`, `git restore`, `git stash drop`/`clear`,
//      `git branch -D`, `git worktree remove --force`, `git push --force`.
//      Reviewed and safe? Re-run with APEX_DESTRUCTIVE_OK=1 immediately in
//      front of that one git command.
//   3. Never build or commit in the primary checkout — it stays on main,
//      clean. Worktrees (scripts/git-new.sh) are the workspace.
//
// Plus the two authority rules the automation draws around itself: merging
// goes through scripts/merge-babysit.sh, and the `shipit` label is Shane's.
//
// The rules match the words the shell will actually run, not the raw command
// text: a commit message, a PR body, a grep pattern or a quoted heredoc body
// that merely *mentions* a guarded command is data, and data never blocks.
// Code is followed recursively, though — `bash -c`, `eval`, `$(…)`, backticks,
// heredocs fed to a shell, `find -exec`, `xargs` and friends all get parsed.
//
// Everything lives in this one file on purpose. The hook runs it with bare
// `node` before anything is installed, and a failed import would exit 1, which
// the hook protocol reads as "allow" — a sibling module could silently switch
// the guard off. Node builtins only.
//
// Protocol: exit 2 with the reason on stderr blocks the call and shows the
// agent the message; anything else allows it. Internal errors allow (fail
// open) — a broken guard must not brick every session. Input the parser
// cannot handle does *not* fail open: it falls back to the legacy regexes, so
// command complexity never becomes a bypass.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Checkout topology
// ---------------------------------------------------------------------------

// Walk up from dir to the checkout root (the first dir owning `.git`).
// A linked worktree stops here at its own root: its `.git` is a file.
export function checkoutRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// Primary checkout = `.git` is a directory (same test dev/port.mjs uses).
export function isPrimaryCheckout(root) {
  try {
    return statSync(join(root, '.git')).isDirectory();
  } catch {
    return false;
  }
}

// The primary checkout that owns this session's project dir — from the
// primary itself, or via a linked worktree's `.git` file, which reads
// `gitdir: <primary>/.git/worktrees/<name>`.
export function primaryRootOf(projectDir) {
  const root = checkoutRoot(projectDir);
  if (!root) return null;
  if (isPrimaryCheckout(root)) return root;
  try {
    const gitdir = readFileSync(join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!gitdir) return null;
    return resolve(root, gitdir[1], '..', '..', '..');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy path — the pre-parser rules, kept verbatim as the fallback for input
// the tokenizer refuses. Blunt, but it blocks; never reach for `allow` here.
// ---------------------------------------------------------------------------

const PKILL_VITE = /\b(pkill|killall)\b[^|;&]*\bvite\b/;
// `kill $(pgrep -f vite)` is the same act spelled with a substitution. The
// parsed path ties the pids to the kill; here, any of the three on one line.
const KILL_VITE = /\bkill\b[^|;&]*\b(pgrep|pidof)\b[^|;&)]*\bvite\b|\b(pgrep|pidof)\b[^|;&]*\bvite\b[^;&]*\|[^;&]*\bkill\b/;
const DESTRUCTIVE_GIT = /\bgit\b[^|;&()]*\b(reset\s+--hard|clean\s+(-[A-Za-z]*f[A-Za-z]*\b|[^|;&]*--force))/;
// #180 — the rest of the commands that throw work away. Coarse on purpose:
// this path only runs for input the tokenizer refused, where a false block
// costs one APEX_DESTRUCTIVE_OK=1 and a miss costs somebody's only copy.
const DESTRUCTIVE_GIT_MORE = [
  /\bgit\b[^|;&()]*\bcheckout\b[^|;&]*(\s--(\s|$)|\s-[A-Za-z]*f[A-Za-z]*(\s|$)|\s--force\b|\s\.(\s|$))/,
  /\bgit\b[^|;&()]*\brestore\b(?![^|;&]*--staged)/,
  /\bgit\b[^|;&()]*\bstash\s+(drop|clear)\b/,
  /\bgit\b[^|;&()]*\bbranch\b[^|;&]*\s-[A-Za-z]*D[A-Za-z]*(\s|$)/,
  /\bgit\b[^|;&()]*\bworktree\s+remove\b[^|;&]*(\s-[A-Za-z]*f[A-Za-z]*(\s|$)|\s--force\b)/,
  /\bgit\b[^|;&()]*\bpush\b[^|;&]*(\s--force(\s|$)|\s--mirror\b|\s-[A-Za-z]*f[A-Za-z]*(\s|$)|\s\+[^\s|;&]+)/,
];
// Merging flows through scripts/merge-babysit.sh, which enforces the merge
// policy; a direct `gh pr merge` (or the API route under it) bypasses both
// the policy and the audit trail. `\bgh\b` also matches an absolute path.
const GH_MERGE = /\bgh\b[^|;&]*\bpr\s+merge\b|\bgh\s+api\b[^|;&]*(\/merge\b|\b(mergePullRequest|enablePullRequestAutoMerge)\b)/;
// The shipit label is the human's per-PR grant for held paths
// (scripts/merge-policy.mjs). The agent applying it to its own PR would
// dissolve the authority boundary the label exists to draw.
const SHIPIT_GRANT =
  /--add-label[^|;&]*\bshipit\b|\bgh\s+api\b[^|;&]*\blabels\b[^|;&]*\bshipit\b|\bgh\s+api\b[^|;&]*\baddLabelsToLabelable\b/;
// What "do not build there, do not commit there" means concretely. The Xcode
// entries are the same rule, not a new one: `xcodegen` writes ios/Apex.xcodeproj
// into whatever checkout it runs in, and `xcodebuild`/`swift build` write build
// products beside it — which every later session would then inherit
// (docs/ios/MASTER.md, session protocol). Read-only tools like `xcrun simctl
// list` are deliberately not here.
const PRIMARY_BANNED =
  /\bgit\s+commit\b|\bnpm\s+run\s+(build|dev(:agent)?|preview|e2e(:live)?|agent:check(:full)?)\b|\bnpx?\s+vite\b|\bxcodebuild\b|\bxcodegen\b|\bswift\s+(build|test)\b/;

const MSG_PKILL =
  'Blocked: `pkill`/`killall` on vite kills every session’s dev server, not just yours (CLAUDE.md). ' +
  'Kill only your own: `lsof -i :$(npm run -s port)`, then kill that PID.';

// Every destructive-git message ends the same way: look first, then override
// the one invocation. Only the first sentence — what this command throws away
// and what the safe neighbour is — differs.
const DESTRUCTIVE_TAIL =
  'If you have looked and it is safe, re-run with APEX_DESTRUCTIVE_OK=1 immediately in front of that ' +
  'one git command — it covers that command only, not the rest of the line, and not a shell it launches.';

const MSG_DESTRUCTIVE =
  'Blocked: `git reset --hard` / `git clean -f` can destroy another session’s only copy of its work ' +
  '(CONTRIBUTING.md, “Never do this”). First run `git status` and read the file list; commit anything ' +
  'that exists nowhere else to a branch. ' +
  DESTRUCTIVE_TAIL;

const MSG_CHECKOUT_PATH =
  'Blocked: `git checkout -- <path>` / `git checkout .` / `git checkout -f` overwrites uncommitted work ' +
  'with HEAD, and in a shared checkout that work may be another session’s only copy (CONTRIBUTING.md, ' +
  '“Never do this”). Run `git status` and `git diff` on those paths first. Switching branches ' +
  '(`git checkout <branch>`), `git checkout -b`, and `-p` are not blocked. ' +
  DESTRUCTIVE_TAIL;

const MSG_RESTORE =
  'Blocked: `git restore <path>` discards uncommitted changes in the working tree — the same harm as ' +
  '`git checkout -- <path>`, and it may be work that exists nowhere else (CONTRIBUTING.md, “Never do ' +
  'this”). `git restore --staged <path>` only unstages and is allowed; `git diff` first. ' +
  DESTRUCTIVE_TAIL;

const MSG_STASH_DROP =
  'Blocked: the stash stack is shared with the primary checkout and every other worktree, so ' +
  '`git stash drop` / `git stash clear` can throw away another session’s only copy of its work ' +
  '(CLAUDE.md). Run `git stash list` and identify your own entry by its message first. ' +
  DESTRUCTIVE_TAIL;

const MSG_BRANCH_DELETE =
  'Blocked: `git branch -D` force-deletes a branch whose commits may be unmerged and referenced by ' +
  'nothing else — another session’s work, or your own before a PR. Lowercase `git branch -d` refuses ' +
  'exactly that case; `scripts/git-tidy.sh` retires merged branches with their worktrees. ' +
  DESTRUCTIVE_TAIL;

const MSG_WORKTREE_REMOVE =
  'Blocked: `git worktree remove --force` deletes a worktree that still has uncommitted changes in it ' +
  '— the force flag exists to override exactly the check that protects them, and the worktree may not ' +
  'be yours (CLAUDE.md). Run `git -C <worktree> status` first; `scripts/git-tidy.sh` retires merged ' +
  'worktrees safely. ' +
  DESTRUCTIVE_TAIL;

const MSG_PUSH_FORCE =
  'Blocked: `git push --force` / `-f` / `+<ref>` / `--mirror` overwrites the remote branch whatever is ' +
  'on it now, including a commit another session pushed while you were working. `--force-with-lease` ' +
  '(and `--force-if-includes`) are allowed and are what you want after a rebase: they refuse when the ' +
  'remote moved. ' +
  DESTRUCTIVE_TAIL;

const MSG_KILL_VITE =
  'Blocked: killing every pid `pgrep`/`pidof` reports for vite kills every session’s dev server, not ' +
  'just yours (CLAUDE.md). Kill only your own: `lsof -i :$(npm run -s port)`, then kill that PID — ' +
  '`lsof -ti :$(npm run -s port) | xargs kill` is fine, because the port is per-worktree.';

const MSG_GH_MERGE =
  'Blocked: merge through `scripts/merge-babysit.sh --yes`, which enforces the merge policy ' +
  '(scripts/merge-policy.mjs) and leaves the audit trail. A PR the policy holds needs Shane to apply ' +
  'the `shipit` label (CONTRIBUTING.md, “Autonomous merging”).';

const MSG_SHIPIT =
  'Blocked: the `shipit` label is Shane’s per-PR grant for policy-held paths — the agent applying it ' +
  'itself would dissolve the authority boundary (CONTRIBUTING.md, “Autonomous merging”). Ask Shane to ' +
  'label the PR.';

const MSG_GRAPHQL_LABEL =
  'Blocked: `addLabelsToLabelable` labels a PR by opaque node id, so the guard cannot tell whether the ' +
  'label is `shipit` — Shane’s per-PR grant for policy-held paths, which the agent applying itself ' +
  'would dissolve the authority boundary of (CONTRIBUTING.md, “Autonomous merging”). Use ' +
  '`gh pr edit <n> --add-label <name>` for ordinary labels; ask Shane for `shipit`.';

const MSG_PRIMARY =
  'Blocked: this would run in the primary checkout, which stays on main, clean — never build or ' +
  'commit there (CLAUDE.md). Start work with `scripts/git-new.sh <type>/<slug>` and run this inside ' +
  'the worktree it prints.';

// cwd plus `cd` targets, found by splitting the raw text on separators. Wrong
// about quoting and heredocs, which is why the parser replaced it; still the
// fallback when the parser throws.
function legacyEffectiveDirs(command, cwd) {
  const dirs = [resolve(cwd)];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const m = segment.trim().match(/^cd\s+(?:"([^"$]+)"|'([^']+)'|([^\s"'$]+))/);
    if (!m) continue;
    let target = m[1] ?? m[2] ?? m[3];
    if (target.startsWith('~')) target = join(homedir(), target.slice(1));
    dirs.push(resolve(cwd, target));
  }
  return dirs;
}

export function legacyDecide(command, cwd, projectDir) {
  if (PKILL_VITE.test(command)) return MSG_PKILL;
  if (KILL_VITE.test(command)) return MSG_KILL_VITE;
  const destructive = DESTRUCTIVE_GIT.test(command) || DESTRUCTIVE_GIT_MORE.some((re) => re.test(command));
  if (destructive && !command.includes('APEX_DESTRUCTIVE_OK=1')) return MSG_DESTRUCTIVE;
  if (GH_MERGE.test(command)) return MSG_GH_MERGE;
  if (SHIPIT_GRANT.test(command)) return MSG_SHIPIT;
  if (PRIMARY_BANNED.test(command)) {
    const primary = primaryRootOf(projectDir);
    for (const dir of legacyEffectiveDirs(command, cwd)) {
      const root = checkoutRoot(dir);
      if (root && root === primary && isPrimaryCheckout(root)) return MSG_PRIMARY;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export class ShellParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellParseError';
  }
}

const MAX_DEPTH = 8;

// Reserved words that occupy command position without being the command:
// `then git clean -fd` runs git, so the keyword is dropped and the next word
// becomes the command name.
const KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done',
  'select', 'function', 'esac', '!', '{', '}',
]);
// Grammar this parser deliberately does not model. Guessing at them would be
// worse than handing the command to the legacy regexes.
const REFUSED_KEYWORDS = new Set(['case', 'coproc']);

const ANSI_C_ESCAPES = {
  a: '', b: '\b', e: '', E: '', f: '\f', n: '\n',
  r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// Leading fd digits plus the operator. Longest alternatives first so `<<-`
// beats `<<` beats `<`, and `2>&1` reads as one dup rather than a `&` split.
const REDIRECT_RE = /(?:\d+)?(&>>|&>|<<-|<<<|<<|<&|<>|<|>>|>\||>&|>)/y;
const ASSIGN_RE = /[A-Za-z_][A-Za-z0-9_]*\+?=/y;
const FD_DUP_RE = /(?:\d+-?|-)/y;
const WORD_BREAK = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '<', '>']);

class ShellParser {
  constructor(src, baseDepth = 0) {
    this.s = src;
    this.i = 0;
    this.out = [];
    this.pending = [];
    this.baseDepth = baseDepth;
    this.backticks = 0;
  }

  parse() {
    this.parseList(this.baseDepth, '');
    return this.out;
  }

  newCommand(depth) {
    return {
      words: [], env: [], redirects: [], heredocs: [],
      hereString: null, pipeFrom: null, subs: [], depth,
    };
  }

  skipBlanks() {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2;
      else return;
    }
  }

  parseList(depth, term) {
    if (depth > MAX_DEPTH) throw new ShellParseError(`shell nesting deeper than ${MAX_DEPTH}`);
    const s = this.s;
    let cmd = this.newCommand(depth);
    let upstream = null;

    const flush = (pipe) => {
      const filled =
        cmd.words.length > 0 || cmd.env.length > 0 || cmd.redirects.length > 0 ||
        cmd.heredocs.length > 0 || cmd.hereString !== null;
      if (filled) {
        cmd.pipeFrom = upstream;
        this.out.push(cmd);
        upstream = pipe ? cmd : null;
      } else if (!pipe) {
        upstream = null;
      }
      cmd = this.newCommand(depth);
    };

    for (;;) {
      this.skipBlanks();
      if (this.i >= s.length) break;
      const c = s[this.i];

      if (c === '\n') {
        this.i++;
        this.consumeHeredocs();
        flush(false);
        continue;
      }
      if (c === '#') {
        const nl = s.indexOf('\n', this.i);
        this.i = nl === -1 ? s.length : nl;
        continue;
      }
      if (c === '`' && this.backticks > 0) {
        if (term !== '`') break;
        this.i++;
        flush(false);
        return;
      }
      if (c === ')') {
        this.i++;
        flush(false);
        if (term === ')') return;
        continue; // stray close paren — tolerate rather than refuse
      }
      if (s.startsWith('&&', this.i) || s.startsWith('||', this.i) || s.startsWith(';;', this.i)) {
        this.i += 2;
        flush(false);
        continue;
      }
      if (s.startsWith('|&', this.i)) {
        this.i += 2;
        flush(true);
        continue;
      }
      if (!s.startsWith('&>', this.i)) {
        if (c === ';') { this.i++; flush(false); continue; }
        if (c === '|') { this.i++; flush(true); continue; }
        if (c === '&') { this.i++; flush(false); continue; }
      }

      REDIRECT_RE.lastIndex = this.i;
      if (REDIRECT_RE.test(s)) {
        this.readRedirect(cmd, depth);
        continue;
      }

      if (c === '(') {
        this.i++;
        flush(false);
        this.parseList(depth + 1, ')');
        continue;
      }

      if (cmd.words.length === 0) {
        ASSIGN_RE.lastIndex = this.i;
        const a = ASSIGN_RE.exec(s);
        if (a) {
          this.i = ASSIGN_RE.lastIndex;
          if (s[this.i] === '(') throw new ShellParseError('array assignment');
          const name = a[0].slice(0, a[0].indexOf('='));
          const value = this.readWord(depth);
          cmd.env.push({
            name,
            value: value ? value.value : '',
            quoted: value ? value.quoted : false,
            dynamic: value ? value.dynamic : false,
          });
          continue;
        }
      }

      const before = this.i;
      const outBefore = this.out.length;
      const w = this.readWord(depth);
      // Commands the word's own expansions contributed — `kill $(pgrep -f
      // vite)` needs the substitution tied to the command it feeds, not just
      // enumerated somewhere in the line.
      if (this.out.length > outBefore) cmd.subs.push(...this.out.slice(outBefore));
      if (!w) {
        if (this.i === before) this.i++; // never spin on an unexpected byte
        continue;
      }
      if (cmd.words.length === 0 && !w.quoted && !w.dynamic) {
        if (REFUSED_KEYWORDS.has(w.value)) throw new ShellParseError(`unsupported keyword: ${w.value}`);
        if (KEYWORDS.has(w.value)) continue;
      }
      cmd.words.push(w);
    }

    if (term) throw new ShellParseError(`unterminated ${term === ')' ? 'command substitution' : 'backquote'}`);
    this.consumeHeredocs();
    flush(false);
  }

  readRedirect(cmd, depth) {
    const s = this.s;
    REDIRECT_RE.lastIndex = this.i;
    const m = REDIRECT_RE.exec(s);
    if (!m) { this.i++; return; }
    this.i = REDIRECT_RE.lastIndex;
    const op = m[1];

    if (op === '<<' || op === '<<-') {
      this.skipBlanks();
      const w = this.readWord(depth);
      const h = {
        delim: w ? w.value : '',
        quotedDelim: w ? w.quoted : false,
        strip: op === '<<-',
        body: '',
        depth,
      };
      cmd.heredocs.push(h);
      this.pending.push(h);
      return;
    }
    if (op === '<<<') {
      this.skipBlanks();
      const w = this.readWord(depth);
      if (w) cmd.hereString = w;
      return;
    }
    if (op === '>&' || op === '<&') {
      FD_DUP_RE.lastIndex = this.i;
      if (FD_DUP_RE.test(s)) { this.i = FD_DUP_RE.lastIndex; return; }
    }
    this.skipBlanks();
    const w = this.readWord(depth);
    if (w) cmd.redirects.push(w);
  }

  // Heredoc bodies start after the newline that ends the line the `<<` sits
  // on — at whatever nesting level that newline is reached, which is what
  // makes `"$(cat <<'EOF' … EOF)"` parse.
  consumeHeredocs() {
    const s = this.s;
    while (this.pending.length) {
      const h = this.pending.shift();
      const lines = [];
      for (;;) {
        if (this.i >= s.length) break;
        const nl = s.indexOf('\n', this.i);
        const end = nl === -1 ? s.length : nl;
        const raw = s.slice(this.i, end);
        const line = h.strip ? raw.replace(/^\t+/, '') : raw;
        this.i = nl === -1 ? s.length : nl + 1;
        if (line === h.delim) break;
        lines.push(line);
        if (nl === -1) break;
      }
      h.body = lines.length ? `${lines.join('\n')}\n` : '';
      // An unquoted delimiter leaves the body expanded: any `$(…)` or
      // backquote inside it is code the shell will run.
      if (!h.quotedDelim) this.scanSubstitutions(h.body, h.depth);
    }
  }

  scanSubstitutions(text, depth) {
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === '\\') { k++; continue; }
      if (ch === "'") {
        const close = text.indexOf("'", k + 1);
        if (close === -1) return;
        k = close;
        continue;
      }
      if (ch === '$' && text[k + 1] === '(' && text[k + 2] !== '(') {
        const end = matchParen(text, k + 2);
        if (end === -1) continue;
        this.subParse(text.slice(k + 2, end), depth + 1);
        k = end;
        continue;
      }
      if (ch === '`') {
        const end = text.indexOf('`', k + 1);
        if (end === -1) continue;
        this.subParse(text.slice(k + 1, end), depth + 1);
        k = end;
      }
    }
  }

  subParse(src, depth) {
    if (depth > MAX_DEPTH) throw new ShellParseError(`shell nesting deeper than ${MAX_DEPTH}`);
    const p = new ShellParser(src, depth);
    for (const c of p.parse()) this.out.push(c);
  }

  readWord(depth) {
    const s = this.s;
    const start = this.i;
    let value = '';
    let quoted = false;
    let dynamic = false;

    while (this.i < s.length) {
      const c = s[this.i];

      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === undefined) { value += '\\'; this.i++; continue; }
        this.i += 2;
        if (n === '\n') continue;
        value += n;
        quoted = true;
        continue;
      }

      if (c === "'") {
        const close = s.indexOf("'", this.i + 1);
        if (close === -1) throw new ShellParseError('unterminated single quote');
        value += s.slice(this.i + 1, close);
        this.i = close + 1;
        quoted = true;
        continue;
      }

      if (c === '"') {
        this.i++;
        quoted = true;
        for (;;) {
          if (this.i >= s.length) throw new ShellParseError('unterminated double quote');
          const d = s[this.i];
          if (d === '"') { this.i++; break; }
          if (d === '\\') {
            const n = s[this.i + 1];
            if (n === undefined) { value += '\\'; this.i++; continue; }
            this.i += 2;
            if (n === '\n') continue;
            if (n === '$' || n === '`' || n === '"' || n === '\\') value += n;
            else value += `\\${n}`;
            continue;
          }
          if (d === '$' || d === '`') {
            const r = this.readExpansion(depth);
            if (r.dynamic) dynamic = true;
            value += r.text;
            continue;
          }
          value += d;
          this.i++;
        }
        continue;
      }

      if (c === '$' && s[this.i + 1] === "'") {
        this.i += 2;
        value += this.readAnsiC();
        quoted = true;
        continue;
      }

      if (c === '$' || c === '`') {
        if (c === '`' && this.backticks > 0) break;
        const r = this.readExpansion(depth);
        if (r.dynamic) dynamic = true;
        value += r.text;
        continue;
      }

      if (WORD_BREAK.has(c)) break;

      value += c;
      this.i++;
    }

    if (this.i === start && value === '' && !quoted) return null;
    return { value, quoted, dynamic };
  }

  // `$(…)`, backquotes, `${…}`, `$((…))`, `$NAME`. Only the first two are
  // code; the rest just make the word dynamic (an unexpanded value we refuse
  // to guess at).
  readExpansion(depth) {
    const s = this.s;
    const c = s[this.i];

    if (c === '`') {
      this.i++;
      this.backticks++;
      try {
        this.parseList(depth + 1, '`');
      } finally {
        this.backticks--;
      }
      return { text: '', dynamic: true };
    }

    // c === '$'
    const n = s[this.i + 1];
    if (n === '(' && s[this.i + 2] === '(') {
      this.i += 3;
      this.skipBalanced('(', ')');
      this.skipBalanced('(', ')');
      return { text: '', dynamic: true };
    }
    if (n === '(') {
      this.i += 2;
      this.parseList(depth + 1, ')');
      return { text: '', dynamic: true };
    }
    if (n === '{') {
      const from = this.i + 2;
      this.i = from;
      this.skipBalanced('{', '}');
      // The expansion's own value is unknowable, but a substitution written
      // inside it still runs: `${x:-$(git clean -fd)}` cleans the tree.
      this.scanSubstitutions(this.s.slice(from, this.i - 1), depth);
      return { text: '', dynamic: true };
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9]|^[@*#?$!-]/.exec(s.slice(this.i + 1, this.i + 64));
    if (name) {
      this.i += 1 + name[0].length;
      return { text: '', dynamic: true };
    }
    this.i++;
    return { text: '$', dynamic: false };
  }

  skipBalanced(open, close) {
    const s = this.s;
    let level = 1;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') { this.i += 2; continue; }
      if (c === open) level++;
      else if (c === close) {
        level--;
        this.i++;
        if (level === 0) return;
        continue;
      }
      this.i++;
    }
    throw new ShellParseError(`unterminated ${open}${close} expansion`);
  }

  readAnsiC() {
    const s = this.s;
    let out = '';
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "'") { this.i++; return out; }
      if (c !== '\\') { out += c; this.i++; continue; }
      const n = s[this.i + 1];
      if (n === undefined) { this.i++; return out; }
      if (n === 'x' || n === 'u' || n === 'U') {
        const width = n === 'x' ? 2 : n === 'u' ? 4 : 8;
        const hex = /^[0-9a-fA-F]+/.exec(s.slice(this.i + 2, this.i + 2 + width));
        if (hex) {
          out += String.fromCodePoint(parseInt(hex[0], 16));
          this.i += 2 + hex[0].length;
          continue;
        }
      }
      const oct = /^[0-7]{1,3}/.exec(s.slice(this.i + 1, this.i + 4));
      if (oct) {
        out += String.fromCharCode(parseInt(oct[0], 8));
        this.i += 1 + oct[0].length;
        continue;
      }
      out += Object.hasOwn(ANSI_C_ESCAPES, n) ? ANSI_C_ESCAPES[n] : `\\${n}`;
      this.i += 2;
    }
    throw new ShellParseError("unterminated $'…' quote");
  }
}

function matchParen(text, from) {
  let level = 1;
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === '(') level++;
    else if (c === ')') {
      level--;
      if (level === 0) return k;
    }
  }
  return -1;
}

/** Every simple command the shell would run, flattened, innermost included. */
export function parseShell(command) {
  return new ShellParser(command).parse();
}

// ---------------------------------------------------------------------------
// Invocation expansion — simple commands to the programs they actually run
// ---------------------------------------------------------------------------

const base = (value) => basename(value);

// Prefixes that run another command. `env` carries through, which is how the
// destructive-git override survives `env APEX_DESTRUCTIVE_OK=1 git clean -fd`
// but not `APEX_DESTRUCTIVE_OK=1 bash -c '…'` (that is code, not a wrapper).
const WRAPPERS = {
  env: { value: ['-u', '--unset', '-C', '--chdir'], code: ['-S', '--split-string'], assignments: true },
  command: {},
  builtin: {},
  exec: { value: ['-a'] },
  nohup: {},
  time: {},
  nice: { value: ['-n', '--adjustment'] },
  ionice: { value: ['-c', '--class', '-n', '--classdata', '-p', '--pid'] },
  timeout: { value: ['-s', '--signal', '-k', '--kill-after'], positionals: 1 },
  stdbuf: { value: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  setsid: {},
  sudo: {
    value: ['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-h', '--host', '-r', '--role', '-t', '--type', '-U', '--other-user'],
    assignments: true,
  },
  doas: { value: ['-u', '-C'] },
  xargs: {
    value: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '--replace', '-i', '-L', '--max-lines', '-l', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'],
  },
  flock: { value: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], code: ['-c', '--command'], positionals: 1 },
  xcrun: { value: ['--sdk', '--toolchain'] },
};

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);

// Names that restart an invocation when they turn up mid-argv unquoted. This
// is what keeps the pre-parser coverage of bare mentions (`watch git clean
// -fd`, `ssh host pkill -f vite`) without letting a quoted string do it.
const EMBED_NAMES = new Set([
  ...Object.keys(WRAPPERS), ...SHELLS,
  'eval', 'pkill', 'killall', 'kill', 'git', 'gh', 'npm', 'npx',
  'xcodebuild', 'xcodegen', 'swift', 'git-clean', 'git-reset', 'git-commit',
]);

function optionName(value) {
  const eq = value.indexOf('=');
  return eq === -1 ? value : value.slice(0, eq);
}

function isOption(value) {
  return value.startsWith('-') && value !== '-';
}

// argv[1..] with options (and the values of options known to take one)
// removed, so `gh pr --repo o/r merge` reads the same as `gh pr merge`.
function positionals(argv, valueOpts) {
  const out = [];
  for (let j = 1; j < argv.length; j++) {
    const v = argv[j].value;
    if (v === '--') continue;
    if (isOption(v)) {
      if (v.indexOf('=') === -1 && valueOpts.has(v)) j++;
      continue;
    }
    out.push(v);
  }
  return out;
}

const GH_VALUE_OPTS = new Set([
  '-R', '--repo', '--hostname', '-t', '--title', '-b', '--body', '-F', '--body-file', '--field',
  '-B', '--base', '-H', '--head', '--header', '-l', '--label', '-a', '--assignee', '-A', '--author',
  '-m', '--milestone', '-j', '--jq', '-q', '--template', '-X', '--method', '-f', '--raw-field',
  '--json', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer',
  '--search', '-L', '--limit', '-S', '--state',
]);
const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
  '--super-prefix', '--config-env', '--attr-source', '--list-cmds',
]);
const NPM_VALUE_OPTS = new Set([
  '--prefix', '-w', '--workspace', '-C', '--cwd', '--userconfig', '--globalconfig', '--registry',
]);
const NPX_VALUE_OPTS = new Set(['-p', '--package', '--userconfig', '--registry', '--shell', '--call']);
const SWIFT_VALUE_OPTS = new Set([
  '--package-path', '-C', '--cache-path', '--scratch-path', '--build-path',
  '--destination', '--triple', '--toolset', '--configuration', '-c', '--sdk', '--toolchain',
]);

/** The git subcommand and its arguments, past the global options. */
function gitParts(inv) {
  const b = base(inv.argv[0].value);
  if (/^git-(clean|reset|commit)$/.test(b)) {
    return { sub: b.slice(4), args: inv.argv.slice(1) };
  }
  if (b !== 'git') return null;
  let j = 1;
  while (j < inv.argv.length) {
    const v = inv.argv[j].value;
    if (v === '--') { j++; break; }
    if (!isOption(v)) break;
    if (v.indexOf('=') === -1 && GIT_VALUE_OPTS.has(v)) j += 2;
    else j++;
  }
  if (j >= inv.argv.length) return null;
  return { sub: inv.argv[j].value, args: inv.argv.slice(j + 1) };
}

/** The literal value of a value-taking option, or null. */
function optionValue(argv, names) {
  for (let j = 1; j < argv.length; j++) {
    const w = argv[j];
    const eq = w.value.indexOf('=');
    if (eq !== -1 && names.has(w.value.slice(0, eq))) {
      return w.dynamic ? null : w.value.slice(eq + 1);
    }
    if (names.has(w.value) && argv[j + 1] && !argv[j + 1].dynamic) return argv[j + 1].value;
  }
  return null;
}

// `subs` carries over for an embedded slice (`watch kill $(pgrep -f vite)`):
// the substitution still feeds the command the slice starts at. `pipeFrom`
// deliberately does not — stdin belongs to the whole original command.
function synth(argv, depth, noEmbed = false, subs = []) {
  return {
    words: argv, env: [], redirects: [], heredocs: [],
    hereString: null, pipeFrom: null, subs, depth, noEmbed,
  };
}

// What a command writes to a shell's stdin, when we can know it.
function stdinText(cmd) {
  const parts = [];
  for (const h of cmd.heredocs) parts.push(h.body);
  if (cmd.hereString) parts.push(cmd.hereString.value);
  if (parts.length) return parts.join('\n');
  if (!cmd.words.length) return null;
  const b = base(cmd.words[0].value);
  if (b !== 'echo' && b !== 'printf') return null;
  return cmd.words
    .slice(1)
    .filter((w) => !/^-[neE]+$/.test(w.value))
    .map((w) => w.value)
    .join(' ');
}

function shellDashC(argv) {
  for (let j = 1; j < argv.length; j++) {
    const v = argv[j].value;
    if (v === '--') return null;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(v)) return argv[j + 1] ?? null;
    if (!isOption(v)) return null;
  }
  return null;
}

// Simple commands -> the programs they run, following every code context.
// `expanded` is every simple command reached on the way, the ones parsed out
// of `bash -c` strings and heredocs included, so a `cd` the shell really runs
// counts even when it is spelled inside quoted code.
function invocationsFor(commands) {
  const invocations = [];
  const expanded = [];
  const queue = commands.slice();
  let budget = 500;

  while (queue.length && budget-- > 0) {
    const cmd = queue.shift();
    expanded.push(cmd);
    if (cmd.depth > MAX_DEPTH) throw new ShellParseError(`shell nesting deeper than ${MAX_DEPTH}`);

    const env = new Map();
    for (const a of cmd.env) env.set(a.name, a.dynamic ? null : a.value);

    let argv = cmd.words;
    const codeStrings = [];

    // Wrappers: peel prefixes, keeping the environment they pass through.
    for (let guard = 0; guard < 16 && argv.length; guard++) {
      const name = base(argv[0].value);
      const spec = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
      if (!spec) break;
      const valueOpts = new Set(spec.value ?? []);
      const codeOpts = new Set(spec.code ?? []);
      let j = 1;
      let skipped = 0;
      while (j < argv.length) {
        const w = argv[j];
        const v = w.value;
        if (v === '--') { j++; break; }
        if (spec.assignments && !w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
          const eq = v.indexOf('=');
          env.set(v.slice(0, eq), w.dynamic ? null : v.slice(eq + 1));
          j++;
          continue;
        }
        if (isOption(v)) {
          const name = optionName(v);
          if (codeOpts.has(name)) {
            const inline = v.indexOf('=') !== -1;
            const codeWord = inline ? v.slice(v.indexOf('=') + 1) : argv[j + 1]?.value;
            if (codeWord) codeStrings.push(codeWord);
            j += inline ? 1 : 2;
            continue;
          }
          if (v.indexOf('=') === -1 && valueOpts.has(name)) j += 2;
          else j++;
          continue;
        }
        if (skipped < (spec.positionals ?? 0)) { skipped++; j++; continue; }
        break;
      }
      if (j >= argv.length) { argv = []; break; }
      argv = argv.slice(j);
    }

    if (!argv.length) {
      for (const code of codeStrings) pushCode(queue, code, cmd.depth + 1);
      continue;
    }

    invocations.push({
      argv,
      env,
      depth: cmd.depth,
      subs: cmd.subs ?? [],
      pipeFrom: cmd.pipeFrom ?? null,
    });

    const b = base(argv[0].value);

    // --- code contexts, followed recursively -------------------------------
    if (SHELLS.has(b)) {
      const dashC = shellDashC(argv);
      if (dashC) codeStrings.push(dashC.value);
      else {
        const stdin = cmd.heredocs.length || cmd.hereString
          ? stdinText(cmd)
          : cmd.pipeFrom
            ? stdinText(cmd.pipeFrom)
            : null;
        if (stdin) codeStrings.push(stdin);
      }
    }
    if (b === 'eval') {
      const joined = argv.slice(1).map((w) => w.value).join(' ');
      if (joined.trim()) codeStrings.push(joined);
    }
    if (b === 'find') {
      for (let j = 1; j < argv.length; j++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(argv[j].value)) continue;
        const slice = [];
        let k = j + 1;
        while (k < argv.length && argv[k].value !== ';' && argv[k].value !== '+') slice.push(argv[k++]);
        if (slice.length) queue.push(synth(slice, cmd.depth + 1));
        j = k;
      }
    }
    const g = gitParts({ argv });
    if (g) {
      if (g.sub === 'submodule' && g.args[0]?.value === 'foreach') {
        const rest = g.args.slice(1).filter((w) => !isOption(w.value));
        if (rest.length === 1) codeStrings.push(rest[0].value);
        else if (rest.length > 1) queue.push(synth(rest, cmd.depth + 1));
      }
      if (g.sub === 'bisect' && g.args[0]?.value === 'run' && g.args.length > 1) {
        queue.push(synth(g.args.slice(1), cmd.depth + 1));
      }
      if (g.sub === 'rebase' || g.sub === 'submodule') {
        const x = optionValue([argv[0], ...g.args], new Set(['-x', '--exec']));
        if (x) codeStrings.push(x);
      }
      // `git -c alias.nuke='!git clean -fd' nuke` runs the shell.
      for (let j = 1; j < argv.length; j++) {
        if (argv[j].value !== '-c' && !argv[j].value.startsWith('-c')) continue;
        const raw = argv[j].value === '-c' ? argv[j + 1]?.value : argv[j].value.slice(2);
        const m = raw && /^alias\.[^=]+=(.*)$/s.exec(raw);
        if (m) codeStrings.push(m[1].replace(/^!/, ''));
      }
    }
    if (b === 'gh') {
      const p = positionals(argv, GH_VALUE_OPTS);
      if (p[0] === 'alias' && p[1] === 'set' && p[3]) codeStrings.push(p[3].replace(/^!/, ''));
    }

    for (const code of codeStrings) pushCode(queue, code, cmd.depth + 1);

    // --- bare mentions in code position ------------------------------------
    // The outer scan already enumerates every index, so the slices it makes
    // do not need scanning again — that would be quadratic for no new hits.
    if (!cmd.noEmbed && b !== 'cd' && b !== 'pushd') {
      for (let j = 1; j < argv.length; j++) {
        const w = argv[j];
        if (w.quoted || w.dynamic) continue;
        if (!EMBED_NAMES.has(base(w.value))) continue;
        queue.push(synth(argv.slice(j), cmd.depth, true, cmd.subs ?? []));
      }
    }
  }

  if (queue.length) throw new ShellParseError('too many nested invocations');
  return { invocations, expanded };
}

function pushCode(queue, code, depth) {
  if (typeof code !== 'string' || !code.trim()) return;
  if (depth > MAX_DEPTH) throw new ShellParseError(`shell nesting deeper than ${MAX_DEPTH}`);
  for (const c of new ShellParser(code, depth).parse()) queue.push(c);
}

// ---------------------------------------------------------------------------
// Matchers — one rule per invocation, over argv rather than raw text
// ---------------------------------------------------------------------------

function isPkillVite(inv) {
  const b = base(inv.argv[0].value);
  if (b !== 'pkill' && b !== 'killall') return false;
  return inv.argv.slice(1).some((w) => /\bvite\b/.test(w.value));
}

// `pgrep -f vite` / `pidof vite`: a pid list that is every session's server.
function isVitePidLookup(cmd) {
  const words = cmd?.words ?? [];
  if (!words.length) return false;
  const b = base(words[0].value);
  if (b !== 'pgrep' && b !== 'pidof') return false;
  return words.slice(1).some((w) => /\bvite\b/.test(w.value));
}

// A `kill` fed by such a lookup — through a substitution (`kill $(pgrep -f
// vite)`) or an upstream pipeline stage (`pgrep -f vite | xargs kill`). The
// lookup on its own is read-only and stays allowed, and so does
// `lsof -ti :$(npm run -s port) | xargs kill`: that port is only ever this
// worktree's, which is what CLAUDE.md tells sessions to use.
function isKillVite(inv) {
  if (base(inv.argv[0].value) !== 'kill') return false;
  if ((inv.subs ?? []).some(isVitePidLookup)) return true;
  for (let up = inv.pipeFrom; up; up = up.pipeFrom) {
    if (isVitePidLookup(up)) return true;
    if ((up.subs ?? []).some(isVitePidLookup)) return true;
  }
  return false;
}

// --- the destructive-git family -------------------------------------------
// One matcher per row, each naming what it would throw away. All of them go
// through the same APEX_DESTRUCTIVE_OK=1 override in decideParsed.

const GIT_CHECKOUT_VALUE_OPTS = new Set([
  '-b', '-B', '--orphan', '--conflict', '--pathspec-from-file', '--recurse-submodules',
]);
const GIT_STASH_VALUE_OPTS = new Set(['-m', '--message']);
const GIT_PUSH_VALUE_OPTS = new Set([
  '--repo', '-o', '--push-option', '--receive-pack', '--exec', '--recurse-submodules', '--signed',
]);

/** Subcommand arguments split at `--`: options before, pathspecs after. */
function splitPathspec(args) {
  const k = args.findIndex((w) => w.value === '--');
  return k === -1 ? { opts: args, paths: [] } : { opts: args.slice(0, k), paths: args.slice(k + 1) };
}

/** Positional arguments of a git subcommand, up to `--`. */
function subPositionals(args, valueOpts = new Set()) {
  const out = [];
  for (let j = 0; j < args.length; j++) {
    const v = args[j].value;
    if (v === '--') break;
    if (isOption(v)) {
      if (v.indexOf('=') === -1 && valueOpts.has(v)) j++;
      continue;
    }
    out.push(v);
  }
  return out;
}

/** An exact long option, `--name` or `--name=value`. `--force-with-lease` is not `--force`. */
function hasLong(args, ...names) {
  return args.some((w) => names.includes(optionName(w.value)));
}

/** A letter inside a short cluster: `-f`, `-fd`, `-xf`. */
function hasShort(args, letter) {
  return args.some((w) => /^-[A-Za-z]+$/.test(w.value) && w.value.slice(1).includes(letter));
}

function gitSub(inv, name) {
  const g = gitParts(inv);
  return g && g.sub === name ? g : null;
}

function isDestructiveGit(inv) {
  const g = gitParts(inv);
  if (!g) return false;
  if (g.sub === 'reset') return g.args.some((w) => w.value === '--hard');
  if (g.sub !== 'clean') return false;
  return g.args.some((w) => w.value === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(w.value));
}

// `git checkout -- <path>`, `git checkout .`, `git checkout -f`: HEAD over the
// working tree. Switching branches, `-b`/`-B`/`--orphan` with no pathspec, and
// the per-hunk `-p` are left alone.
function isCheckoutDiscard(inv) {
  const g = gitSub(inv, 'checkout');
  if (!g) return false;
  const { opts, paths } = splitPathspec(g.args);
  if (hasLong(opts, '--patch') || hasShort(opts, 'p')) return false;
  if (hasLong(opts, '--force') || hasShort(opts, 'f')) return true;
  if (paths.length) return true;
  return subPositionals(opts, GIT_CHECKOUT_VALUE_OPTS).includes('.');
}

// `git restore <path>` is the modern spelling of the same discard. Only
// `--staged` on its own (unstage, keep the file) is not.
function isRestoreDiscard(inv) {
  const g = gitSub(inv, 'restore');
  if (!g) return false;
  const { opts } = splitPathspec(g.args);
  const staged = hasLong(opts, '--staged') || hasShort(opts, 'S');
  const worktree = hasLong(opts, '--worktree') || hasShort(opts, 'W');
  return !staged || worktree;
}

// The stash stack is one per repository — shared with the primary checkout and
// every other worktree, so a drop may not be dropping your own entry.
function isStashDiscard(inv) {
  const g = gitSub(inv, 'stash');
  if (!g) return false;
  const p = subPositionals(g.args, GIT_STASH_VALUE_OPTS);
  return p[0] === 'drop' || p[0] === 'clear';
}

// `git branch -D` (or `-d --force`) deletes an unmerged branch — commits that
// may be referenced by nothing else. Lowercase `-d` alone refuses that case.
function isBranchForceDelete(inv) {
  const g = gitSub(inv, 'branch');
  if (!g) return false;
  const { opts } = splitPathspec(g.args);
  if (hasShort(opts, 'D')) return true;
  const del = hasLong(opts, '--delete') || hasShort(opts, 'd');
  return del && (hasLong(opts, '--force') || hasShort(opts, 'f'));
}

// `git worktree remove --force` overrides the check that refuses to delete a
// worktree with uncommitted changes in it.
function isWorktreeForceRemove(inv) {
  const g = gitSub(inv, 'worktree');
  if (!g) return false;
  if (subPositionals(g.args)[0] !== 'remove') return false;
  const { opts } = splitPathspec(g.args);
  return hasLong(opts, '--force') || hasShort(opts, 'f');
}

// The weakest row of #180: branch protection already refuses this on `main`.
// `--force-with-lease` / `--force-if-includes` are routine after a rebase and
// stay allowed — they are exactly the forms that refuse when the remote moved.
function isForcePush(inv) {
  const g = gitSub(inv, 'push');
  if (!g) return false;
  const { opts } = splitPathspec(g.args);
  if (hasLong(opts, '--force', '--mirror')) return true;
  if (hasShort(opts, 'f')) return true;
  return subPositionals(g.args, GIT_PUSH_VALUE_OPTS).some((v) => v.startsWith('+') && v.length > 1);
}

const DESTRUCTIVE_RULES = [
  [isDestructiveGit, MSG_DESTRUCTIVE],
  [isCheckoutDiscard, MSG_CHECKOUT_PATH],
  [isRestoreDiscard, MSG_RESTORE],
  [isStashDiscard, MSG_STASH_DROP],
  [isBranchForceDelete, MSG_BRANCH_DELETE],
  [isWorktreeForceRemove, MSG_WORKTREE_REMOVE],
  [isForcePush, MSG_PUSH_FORCE],
];

/** The reason this invocation throws work away, or null. */
function destructiveReason(inv) {
  for (const [match, message] of DESTRUCTIVE_RULES) {
    if (match(inv)) return message;
  }
  return null;
}

// A GraphQL mutation is the same act as the REST route, spelled differently:
// only the mutation name identifies it, and it sits inside a `-f query=…`
// value. Gated on `gh api graphql` so that writing the name in a PR body or
// an issue title stays data.
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;
const GRAPHQL_LABEL = /\baddLabelsToLabelable\b/;

function isGhGraphql(inv, mutation) {
  if (base(inv.argv[0].value) !== 'gh') return false;
  const p = positionals(inv.argv, GH_VALUE_OPTS);
  if (p[0] !== 'api' || p[1] !== 'graphql') return false;
  return inv.argv.some((w) => mutation.test(w.value));
}

function isGhMerge(inv) {
  if (base(inv.argv[0].value) !== 'gh') return false;
  if (isGhGraphql(inv, GRAPHQL_MERGE)) return true;
  const p = positionals(inv.argv, GH_VALUE_OPTS);
  if (p[0] === 'pr' && p[1] === 'merge') return true;
  return p[0] === 'api' && inv.argv.some((w) => /\/merge\b/.test(w.value));
}

function isShipitGrant(inv) {
  if (base(inv.argv[0].value) !== 'gh') return false;
  for (let j = 1; j < inv.argv.length; j++) {
    const v = inv.argv[j].value;
    if (v === '--add-label' && /\bshipit\b/.test(inv.argv[j + 1]?.value ?? '')) return true;
    if (v.startsWith('--add-label=') && /\bshipit\b/.test(v)) return true;
  }
  const p = positionals(inv.argv, GH_VALUE_OPTS);
  if (p[0] !== 'api') return false;
  return (
    inv.argv.some((w) => /\blabels\b/.test(w.value)) &&
    inv.argv.some((w) => /\bshipit\b/.test(w.value))
  );
}

const BANNED_SCRIPT = /^(build|dev(:agent)?|preview|e2e(:live)?|agent:check(:full)?)\b/;

function isPrimaryBanned(inv) {
  const b = base(inv.argv[0].value);
  if (b === 'xcodebuild' || b === 'xcodegen') return true;
  if (gitParts(inv)?.sub === 'commit') return true;
  if (b === 'npm') {
    const p = positionals(inv.argv, NPM_VALUE_OPTS);
    if ((p[0] === 'run' || p[0] === 'run-script') && p[1] && BANNED_SCRIPT.test(p[1])) return true;
    if ((p[0] === 'exec' || p[0] === 'x') && p.includes('vite')) return true;
    return false;
  }
  if (b === 'npx') return positionals(inv.argv, NPX_VALUE_OPTS)[0] === 'vite';
  if (b === 'swift') {
    const p = positionals(inv.argv, SWIFT_VALUE_OPTS);
    return p[0] === 'build' || p[0] === 'test';
  }
  return false;
}

// Directories an invocation names for itself: `git -C`, `npm --prefix`,
// `swift --package-path`. Legacy matched none of these forms at all, so
// recognising the command without honouring its target would leave the hole
// the widening was meant to close.
function invocationDirs(inv, cwd) {
  const b = base(inv.argv[0].value);
  let target = null;
  if (b === 'git') target = optionValue(inv.argv, new Set(['-C', '--git-dir', '--work-tree']));
  else if (b === 'npm') target = optionValue(inv.argv, new Set(['--prefix', '-C', '--cwd']));
  else if (b === 'swift') target = optionValue(inv.argv, new Set(['--package-path', '-C']));
  if (!target) return [];
  return [resolveTarget(target, cwd)];
}

function resolveTarget(target, cwd) {
  const t = target.startsWith('~') ? join(homedir(), target.slice(1)) : target;
  return resolve(cwd, t);
}

function dirsFromCommands(commands, cwd) {
  const dirs = [resolve(cwd)];
  for (const cmd of commands) {
    if (!cmd.words.length) continue;
    const b = base(cmd.words[0].value);
    if (b !== 'cd' && b !== 'pushd') continue;
    for (const w of cmd.words.slice(1)) {
      if (isOption(w.value)) continue;
      if (w.dynamic || w.value === '') break;
      dirs.push(resolveTarget(w.value, cwd));
      break;
    }
  }
  return dirs;
}

// Directories a command may execute in: the hook cwd plus any literal `cd`
// target the shell would actually run. `cd "$SOMEWHERE"` with an unexpanded
// variable is skipped rather than guessed at, and a `cd` inside a heredoc
// body or a quoted argument is text, not a directory change.
export function effectiveDirs(command, cwd) {
  try {
    return dirsFromCommands(parseShell(command), cwd);
  } catch {
    return legacyEffectiveDirs(command, cwd);
  }
}

function decideParsed(commands, cwd, projectDir) {
  const { invocations, expanded } = invocationsFor(commands);

  if (invocations.some(isPkillVite)) return MSG_PKILL;
  if (invocations.some(isKillVite)) return MSG_KILL_VITE;

  for (const inv of invocations) {
    const reason = destructiveReason(inv);
    if (!reason) continue;
    // The override is an environment assignment on this very invocation —
    // directly, or handed on by a wrapper like `env`. Exported earlier, set on
    // a neighbour in the chain, or merely quoted somewhere in the line: no.
    if (inv.env.get('APEX_DESTRUCTIVE_OK') === '1') continue;
    return reason;
  }

  if (invocations.some(isGhMerge)) return MSG_GH_MERGE;
  if (invocations.some((inv) => isGhGraphql(inv, GRAPHQL_LABEL))) return MSG_GRAPHQL_LABEL;
  if (invocations.some(isShipitGrant)) return MSG_SHIPIT;

  const banned = invocations.filter(isPrimaryBanned);
  if (banned.length) {
    const primary = primaryRootOf(projectDir);
    const shared = dirsFromCommands(expanded, cwd);
    for (const inv of banned) {
      for (const dir of [...shared, ...invocationDirs(inv, cwd)]) {
        const root = checkoutRoot(dir);
        if (root && root === primary && isPrimaryCheckout(root)) return MSG_PRIMARY;
      }
    }
  }

  return null;
}

export function decide(command, cwd, projectDir) {
  let commands;
  try {
    commands = parseShell(command);
  } catch {
    return legacyDecide(command, cwd, projectDir);
  }
  try {
    return decideParsed(commands, cwd, projectDir);
  } catch {
    return legacyDecide(command, cwd, projectDir);
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (input.tool_name !== 'Bash') return 0;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return 0;
  const cwd = input.cwd || process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;

  let verdict = null;
  try {
    verdict = decide(command, cwd, projectDir);
  } catch {
    return 0; // fail open
  }
  if (verdict) {
    process.stderr.write(verdict + '\n');
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exit(main());
}
