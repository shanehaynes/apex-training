import { MEMORY_KIND_ORDER, memoryFileLabel, type CoachMemory, type MemoryKind } from './memory.js';

// The coach's notebook (lane D02): the one page where the athlete sees and
// controls everything the coach carries between conversations — the memory
// (lane C02's table), the coaching contract and the overnight reflections
// that propose edits to it (lane D01), and the doctrine the coach prescribes
// from. This module is the pure, React-free half: the client types for the
// contract and reflections, the readers that tell "the endpoint answered" from
// "the endpoint is not there yet", the list transitions the tabs apply
// optimistically, the line diff a reflection card shows, and the block parser
// the doctrine tab renders with. The components in
// src/components/notebook/ are thin over these.
//
// Decision D-C02 makes every self-improvement a proposal the athlete
// approves; nothing here writes anything — the API helpers in src/lib/api.ts
// do, and the tabs call them after the athlete's click.

// ─── Tabs ────────────────────────────────────────────────────────────────────

export const NOTEBOOK_TABS = ['memory', 'contract', 'doctrine'] as const;
export type NotebookTab = (typeof NOTEBOOK_TABS)[number];

export const NOTEBOOK_TAB_LABELS: Record<NotebookTab, string> = {
  memory: 'Memory',
  contract: 'Contract',
  doctrine: 'Doctrine',
};

// ─── Contract and reflections (lane D01's contract, coded against) ──────────

/** profiles.coach_contract's bound; '' clears it. */
export const CONTRACT_MAX = 2000;

export type ReflectionResolution = 'accepted' | 'rejected';

/** One overnight reflection as /api/coach-reflections reports it. */
export interface CoachReflection {
  id: string;
  /** The day the reflection ran over (YYYY-MM-DD). */
  day: string;
  status: string;
  contract_before: string | null;
  contract_after: string | null;
  reason: string | null;
  memory_proposal_ids: string[];
  created_at: string;
  resolved_at: string | null;
  resolution: ReflectionResolution | null;
}

/** What the notebook reads off GET /api/profile once lane D01 has landed. */
export interface NotebookProfile {
  coachContract: string;
  reflectionOptIn: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The HTTP status on a thrown request failure (ApiError.status), or null for
 * anything else. Duck-typed rather than instanceof, so this module never
 * imports the API client (and its Supabase singleton) into a pure file.
 */
export function statusOf(err: unknown): number | null {
  return isRecord(err) && typeof err.status === 'number' ? err.status : null;
}

/**
 * True when a failure means "not there yet" rather than "broken": the handler
 * is missing (404, lane D01 has not merged) or the column is (409
 * column-missing, the tips_seen precedent). The contract tab shows its banner
 * for these and never toasts.
 */
export function isNotAvailable(err: unknown): boolean {
  const status = statusOf(err);
  return status === 404 || status === 409;
}

/**
 * The contract fields of a GET /api/profile payload, or null when the payload
 * predates them — a server without lane D01 answers 200 with the key status
 * and no `coachContract` at all, which is the same "not available yet" as a
 * 404 on the reflections and must render the same banner, not an editor
 * whose save would 409.
 */
export function readNotebookProfile(payload: unknown): NotebookProfile | null {
  if (!isRecord(payload) || !('coachContract' in payload)) return null;
  const contract = payload.coachContract;
  return {
    coachContract: typeof contract === 'string' ? contract : '',
    reflectionOptIn: payload.reflectionOptIn === true,
  };
}

/** The reflections of a GET /api/coach-reflections payload, or null when the shape is not one. */
export function readReflections(payload: unknown): CoachReflection[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.reflections)) return null;
  return payload.reflections.filter(isReflection);
}

function isReflection(value: unknown): value is CoachReflection {
  return isRecord(value) && typeof value.id === 'string' && typeof value.day === 'string';
}

/** A reflection still waiting on the athlete: nothing has resolved it. */
export function isPendingReflection(r: CoachReflection): boolean {
  return r.resolved_at === null && r.resolution === null;
}

/** Whether the card has a contract change to show (a reflection may propose memories only). */
export function reflectionChangesContract(r: CoachReflection): boolean {
  return (r.contract_before ?? '') !== (r.contract_after ?? '');
}

/** Pending first (newest on top), then resolved newest first. */
export function splitReflections(list: readonly CoachReflection[]): {
  pending: CoachReflection[];
  resolved: CoachReflection[];
} {
  const byNewest = (a: CoachReflection, b: CoachReflection) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
  return {
    pending: list.filter(isPendingReflection).sort(byNewest),
    resolved: list.filter(r => !isPendingReflection(r)).sort(byNewest),
  };
}

/** The list after the athlete resolved one reflection (optimistic; the server stamps its own time). */
export function resolveInList(
  list: readonly CoachReflection[],
  id: string,
  resolution: ReflectionResolution,
  at: string,
): CoachReflection[] {
  return list.map(r => (r.id === id ? { ...r, status: resolution, resolution, resolved_at: at } : r));
}

// ─── Memory list transitions ─────────────────────────────────────────────────

export interface MemoryKindGroup {
  kind: MemoryKind;
  /** "injuries", "goals" — the memory file's stem, what the coach calls the group too. */
  label: string;
  memories: CoachMemory[];
}

/**
 * The memory tab's two halves from the API's flat list: every proposal
 * (newest first, as listed), and the confirmed rows grouped by kind in the
 * prompt's order — what constrains the programming first. Kinds with nothing
 * in them are left out, so an athlete with two goals and nothing else sees
 * one heading, not five.
 */
export function splitMemories(memories: readonly CoachMemory[]): {
  proposals: CoachMemory[];
  confirmed: MemoryKindGroup[];
} {
  const proposals = memories.filter(m => !m.confirmed);
  const confirmed = MEMORY_KIND_ORDER.flatMap(kind => {
    const rows = memories.filter(m => m.confirmed && m.kind === kind);
    return rows.length > 0 ? [{ kind, label: memoryFileLabel(kind), memories: rows }] : [];
  });
  return { proposals, confirmed };
}

/** The list after a proposal is accepted: confirmed in place, ordering untouched. */
export function confirmInList(list: readonly CoachMemory[], id: string, at: string): CoachMemory[] {
  return list.map(m => (m.id === id ? { ...m, confirmed: true, confirmed_at: at } : m));
}

/** The list after one memory is forgotten (archived server-side, gone here). */
export function forgetInList(list: readonly CoachMemory[], id: string): CoachMemory[] {
  return list.filter(m => m.id !== id);
}

/** The list with a just-added fact on top, where the newest-first GET would put it. */
export function prependToList(list: readonly CoachMemory[], memory: CoachMemory): CoachMemory[] {
  return [memory, ...list.filter(m => m.id !== memory.id)];
}

/**
 * The list with one row put back (or its optimistic edit undone) after the
 * server refused the write: the row lands where the newest-first order has
 * it, so a failed forget does not jump to the top. Rows already in the list
 * are replaced, not duplicated.
 */
export function restoreToList(list: readonly CoachMemory[], memory: CoachMemory): CoachMemory[] {
  const rest = list.filter(m => m.id !== memory.id);
  const at = rest.findIndex(m => m.created_at < memory.created_at);
  return at === -1 ? [...rest, memory] : [...rest.slice(0, at), memory, ...rest.slice(at)];
}

/** The text of a thrown failure — an ApiError carries the server's detail ("Memory is full …"). */
export function messageOf(err: unknown, fallback: string): string {
  const message = isRecord(err) && typeof err.message === 'string' ? err.message.trim() : '';
  return message || fallback;
}

/** Where a memory came from, for the small line under a proposal. */
export function memorySourceLabel(source: CoachMemory['source_kind']): string {
  switch (source) {
    case 'reflection': return 'from an overnight reflection';
    case 'chat': return 'from a conversation';
    case 'user': return 'added by you';
    default: return '';
  }
}

// ─── Line diff for a contract-edit proposal ──────────────────────────────────

export interface DiffLine {
  text: string;
  /** True on a line the other side does not have: removed on the before side, added on the after side. */
  changed: boolean;
}

/**
 * The two blocks a reflection card shows: the contract before and after, line
 * by line, with the lines that differ marked. A longest-common-subsequence
 * over lines — contracts are a page at most, so the quadratic table is
 * nothing, and it needs no dependency. Lines are compared trimmed, so a
 * trailing space is not a change.
 */
export function diffLines(before: string, after: string): { before: DiffLine[]; after: DiffLine[] } {
  const a = splitContract(before);
  const b = splitContract(after);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i].trim() === b[j].trim()
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const outBefore: DiffLine[] = [];
  const outAfter: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].trim() === b[j].trim()) {
      outBefore.push({ text: a[i], changed: false });
      outAfter.push({ text: b[j], changed: false });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      outBefore.push({ text: a[i], changed: true });
      i++;
    } else {
      outAfter.push({ text: b[j], changed: true });
      j++;
    }
  }
  for (; i < n; i++) outBefore.push({ text: a[i], changed: true });
  for (; j < m; j++) outAfter.push({ text: b[j], changed: true });
  return { before: outBefore, after: outAfter };
}

function splitContract(text: string): string[] {
  const t = text.replace(/\r\n?/g, '\n');
  return t === '' ? [] : t.split('\n');
}

// ─── Doctrine text → blocks ──────────────────────────────────────────────────

export type DoctrineBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

/**
 * The doctrine's plain text (src/lib/coach/doctrine/*) as blocks the tab
 * renders: a `## ` line is a heading, a run of non-blank lines a paragraph,
 * and a paragraph that starts with "1. " or "- " a list item — consecutive
 * items of one kind fold into one list, blank lines between them or not,
 * because the doctrine writes its numbered points as separate paragraphs.
 * Nothing else is markdown: the chat renders replies as plain text, and the
 * doctrine is written to read as prose.
 */
export function doctrineBlocks(text: string): DoctrineBlock[] {
  const blocks: DoctrineBlock[] = [];
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      blocks.push({ kind: 'heading', text: heading[1].trim() });
      continue;
    }
    // A paragraph may hold several list lines, each an item of its own.
    const items = lines.map(l => /^(?:\d+[.)]|[-*•])\s+(.*)$/.exec(l));
    if (items.every(Boolean)) {
      const ordered = /^\d/.test(lines[0]);
      const texts = items.map(m => m![1].trim());
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'list' && last.ordered === ordered) last.items.push(...texts);
      else blocks.push({ kind: 'list', ordered, items: texts });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: lines.join(' ') });
  }
  return blocks;
}
