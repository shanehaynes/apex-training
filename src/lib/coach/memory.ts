import type Anthropic from '@anthropic-ai/sdk';
import { sanitizeInlineText } from './prompt.js';

// The coach's memory (lane C02): short, typed facts the athlete has confirmed
// — "left shoulder: avoid overhead pressing until cleared", "prefers morning
// sessions", "goal: Rainier June 2027". They live in the coach_memory table
// and reach the model two ways: the confirmed set is rendered into the live
// half of the prompt (<athlete_memory>, bounded), and the model can read and
// propose changes through Anthropic's memory tool, which speaks in files
// under a virtual /memories directory. This module is the pure, React-free
// vocabulary both sides share: the kinds, the path ↔ kind mapping, the
// command shapes, and the labels a confirm card shows. The Postgres backend
// is api/_lib/coach/memory.ts.
//
// The one rule that shapes everything here: NOTHING IS REMEMBERED WITHOUT
// THE ATHLETE'S CLICK (decision D-C03). `view` is a read and runs inside the
// server-side loop like any read tool; every other command is a write and
// becomes a confirm card, exactly like create_event. The card's label and
// preview are computed here from the command alone, because the client has
// no memory rows to resolve against.

/** The tool's name — fixed by the API for memory_20250818. */
export const MEMORY_TOOL = 'memory';

/** The virtual directory the model addresses. */
export const MEMORY_ROOT = '/memories';

export const MEMORY_KINDS = ['injury', 'preference', 'goal', 'history', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** One virtual file per kind. A file is a VIEW over the kind's confirmed rows, never a stored blob. */
export const MEMORY_FILES: Record<MemoryKind, string> = {
  injury: 'injuries.md',
  preference: 'preferences.md',
  goal: 'goals.md',
  history: 'history.md',
  note: 'notes.md',
};

/** The kinds in the order the prompt lists them: what constrains the programming first. */
export const MEMORY_KIND_ORDER: readonly MemoryKind[] = ['injury', 'goal', 'preference', 'history', 'note'];

/** coach_memory.content's CHECK: 1–500 characters. */
export const MEMORY_CONTENT_MAX = 500;

/** Confirmed rows one user may hold; a write past it is refused with a message. */
export const MEMORY_CONFIRMED_CAP = 200;

/** Rows rendered into the prompt; the rest stay reachable through `view`. */
export const MEMORY_PROMPT_CAP = 60;

/**
 * The tool definition the chat request carries. The SDK's typed
 * memory_20250818 tool is in the plain (non-beta) ToolUnion and
 * client.messages.stream accepts it, so no beta client and no custom
 * input_schema — the API knows the six commands.
 */
export const memoryToolSchema: Anthropic.MemoryTool20250818 = { type: 'memory_20250818', name: MEMORY_TOOL };

// ─── Paths ───────────────────────────────────────────────────────────────────

/** '/memories/injuries.md' with a leading slash and no trailing one; null for a non-string. */
export function normalizeMemoryPath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  let p = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function isMemoryRoot(path: unknown): boolean {
  const p = normalizeMemoryPath(path);
  return p === MEMORY_ROOT || p === '/';
}

export function pathForKind(kind: MemoryKind): string {
  return `${MEMORY_ROOT}/${MEMORY_FILES[kind]}`;
}

/** The kind a file path names ('/memories/injuries.md', 'memories/injuries' both work), or null. */
export function kindForPath(path: unknown): MemoryKind | null {
  const p = normalizeMemoryPath(path);
  if (!p || !p.startsWith(`${MEMORY_ROOT}/`)) return null;
  const file = p.slice(MEMORY_ROOT.length + 1).toLowerCase();
  for (const kind of MEMORY_KINDS) {
    const name = MEMORY_FILES[kind];
    if (file === name || file === name.replace(/\.md$/, '')) return kind;
  }
  return null;
}

/** "injuries" — the file's stem, for chips and labels. */
export function memoryFileLabel(kind: MemoryKind): string {
  return MEMORY_FILES[kind].replace(/\.md$/, '');
}

/** The five paths, for an error message that teaches the model the layout. */
export function memoryPathList(): string {
  return MEMORY_KINDS.map(pathForKind).join(', ');
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** The six memory_20250818 commands, as the SDK types them (BetaMemoryTool20250818Command). */
export type MemoryCommand =
  | { command: 'view'; path: string }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A memory command from a tool_use input, or null when the shape is not one
 * of the six. Lenient on the payload fields (a missing file_text reads as
 * ''), strict on the command name and the path: the backend answers the
 * rest with a message the model can act on.
 */
export function parseMemoryCommand(input: unknown): MemoryCommand | null {
  if (!isRecord(input) || typeof input.command !== 'string') return null;
  const path = str(input.path);
  switch (input.command) {
    case 'view':        return path ? { command: 'view', path } : null;
    case 'create':      return path ? { command: 'create', path, file_text: str(input.file_text) } : null;
    case 'str_replace': return path ? { command: 'str_replace', path, old_str: str(input.old_str), new_str: str(input.new_str) } : null;
    case 'insert':      return path ? { command: 'insert', path, insert_line: typeof input.insert_line === 'number' ? input.insert_line : 0, insert_text: str(input.insert_text) } : null;
    case 'delete':      return path ? { command: 'delete', path } : null;
    case 'rename':      return { command: 'rename', old_path: str(input.old_path), new_path: str(input.new_path) };
    default:            return null;
  }
}

/** True when the input is a `view` — the one memory command that is a read. */
export function isMemoryView(input: unknown): boolean {
  return isRecord(input) && input.command === 'view';
}

// ─── Lines ───────────────────────────────────────────────────────────────────

/**
 * The facts in a file_text / insert_text / new_str: one per non-empty line.
 * The model writes back what `view` showed it, so a bullet, a numbering and
 * the `[id:<uuid>]` marker are stripped; markdown headings are skipped;
 * inner whitespace collapses to one space. Nothing else is altered — the
 * prompt renderer sanitizes on the way out.
 */
export function memoryLines(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripLineMarkers(raw);
    if (!line || line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

/** The [id:<uuid>] marker at the head of a rendered line, when present. */
export function memoryIdOf(line: string): string | null {
  const m = /^\s*(?:[-*•]\s*)?\[id:([0-9a-f-]{36})\]/i.exec(line);
  return m ? m[1].toLowerCase() : null;
}

function stripLineMarkers(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/^\s*\[id:[^\]]*\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Labels and previews ─────────────────────────────────────────────────────

/** How long a fact may run inside a card label before it is cut. */
const LABEL_TEXT_MAX = 80;

function cut(text: string, max = LABEL_TEXT_MAX): string {
  const shown = sanitizeInlineText(text, max);
  return shown + (text.trim().length > max ? '…' : '');
}

export type MemoryWriteAction = 'remember' | 'update' | 'forget' | 'refused';

/**
 * What a memory write will do, from the command alone: the card's one-line
 * label and the lines the preview shows. `before` / `after` hold the fact
 * text on each side (empty when there is none to show).
 */
export interface MemoryWriteDescription {
  action: MemoryWriteAction;
  label: string;
  /** The file's stem ("injuries"), or '' when the path names none. */
  file: string;
  before: string[];
  after: string[];
}

export function describeMemoryWrite(input: unknown): MemoryWriteDescription {
  const cmd = parseMemoryCommand(input);
  const refused = (why: string): MemoryWriteDescription => ({ action: 'refused', label: `Update memory: ${why}`, file: '', before: [], after: [] });
  if (!cmd) return refused('malformed command');
  if (cmd.command === 'view') return refused('view is a read');
  if (cmd.command === 'rename') return refused('rename is not supported');

  const kind = kindForPath(cmd.path);
  const file = kind ? memoryFileLabel(kind) : '';
  const unknownPath = (): MemoryWriteDescription => ({
    action: 'refused', label: `Update memory: unknown file ${cut(cmd.path, 40)}`, file: '', before: [], after: [],
  });

  if (cmd.command === 'create' || cmd.command === 'insert') {
    if (!kind) return unknownPath();
    const after = memoryLines(cmd.command === 'create' ? cmd.file_text : cmd.insert_text);
    if (after.length === 0) return { action: 'refused', label: `Update memory: nothing to remember in ${file}`, file, before: [], after: [] };
    const more = after.length > 1 ? ` (+${after.length - 1} more)` : '';
    return { action: 'remember', label: `Remember: ${cut(after[0])}${more}`, file, before: [], after };
  }

  if (cmd.command === 'delete') {
    if (isMemoryRoot(cmd.path)) return refused('cannot delete the whole memory');
    if (!kind) return unknownPath();
    return { action: 'forget', label: `Forget: every ${file} memory`, file, before: [], after: [] };
  }

  // str_replace
  if (!kind) return unknownPath();
  const before = memoryLines(cmd.old_str);
  const after = memoryLines(cmd.new_str);
  const old = before[0] ?? memoryIdOf(cmd.old_str) ?? '';
  if (!old) return { action: 'refused', label: `Update memory: nothing to match in ${file}`, file, before: [], after };
  if (after.length === 0) return { action: 'forget', label: `Forget: ${cut(old)}`, file, before, after: [] };
  return { action: 'update', label: `Update memory: ${cut(old, 40)} → ${cut(after[0], 40)}`, file, before, after };
}

/** The label a confirm card shows for a memory write. */
export function memoryWriteLabel(input: unknown): string {
  return describeMemoryWrite(input).label;
}

/**
 * The chip for a memory read: "Checked: memory (injuries)" for a file,
 * "Checked: memory" for the directory or an unknown path. Never throws.
 */
export function memoryReadChip(input: unknown): string {
  const path = isRecord(input) ? input.path : undefined;
  const kind = kindForPath(path);
  return kind ? `Checked: memory (${memoryFileLabel(kind)})` : 'Checked: memory';
}

// ─── Client types ────────────────────────────────────────────────────────────

/** One memory as /api/coach-memory reports it. */
export interface CoachMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  /** null for an athlete-confirmed fact; set by reflection (lane D01). */
  confidence: number | null;
  source_kind: 'chat' | 'reflection' | 'user' | null;
  created_at: string;
  /** null = proposed, not yet in the prompt. */
  confirmed_at: string | null;
  confirmed: boolean;
}

/** A fact as the prompt renders it: the kind and the text, nothing else. */
export interface MemoryPromptEntry {
  kind: MemoryKind;
  content: string;
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}
