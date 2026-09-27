import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import type { CoachMemoryRow } from '../../../src/lib/db/types.js';
import { sanitizeInlineText } from '../../../src/lib/coach/prompt.js';
import {
  isMemoryRoot, kindForPath, memoryFileLabel, memoryIdOf, memoryLines, memoryPathList, MEMORY_CONFIRMED_CAP,
  MEMORY_CONTENT_MAX, MEMORY_FILES, MEMORY_KINDS, MEMORY_ROOT, parseMemoryCommand, pathForKind,
  type MemoryKind, type MemoryPromptEntry,
} from '../../../src/lib/coach/memory.js';

// The Postgres backend of the coach's memory (lane C02): the confirmed rows
// as the prompt reads them, the virtual /memories files the model views,
// and the one function that turns a CONFIRMED write command into rows.
//
// The model speaks Anthropic's memory tool — files, lines, str_replace — and
// the table speaks rows. The bridge is deliberately thin: a file is the
// kind's confirmed rows rendered one per line, `- [id:<uuid>] <content>`, so
// what the model reads back is exactly what it can name in a str_replace.
// Nothing here is reached without the athlete's click except `viewPath`,
// which api/chat.ts runs inside the server-side read loop.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The rows that render anywhere the model can see. */
function liveRows(supabase: Admin, userId: string) {
  return supabase
    .from('coach_memory')
    .select('*')
    .eq('user_id', userId)
    .not('confirmed_at', 'is', null)
    .is('archived_at', null)
    .is('superseded_by', null);
}

/**
 * This user's current confirmed facts, newest first, capped at the table's
 * own bound. Throws on a database error — the prompt builder catches and
 * degrades to no memory, the tool paths answer with a message.
 */
export async function listConfirmed(supabase: Admin, userId: string): Promise<CoachMemoryRow[]> {
  const { data, error } = await liveRows(supabase, userId)
    .order('created_at', { ascending: false })
    .limit(MEMORY_CONFIRMED_CAP);
  if (error) throw new Error(`coach_memory fetch failed: ${error.message}`);
  return (data ?? []) as CoachMemoryRow[];
}

/** The prompt's view of the rows: kind and text, in the order given. */
export function toPromptEntries(rows: CoachMemoryRow[]): MemoryPromptEntry[] {
  return rows.map(r => ({ kind: r.kind, content: r.content }));
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function oldestFirst(rows: CoachMemoryRow[]): CoachMemoryRow[] {
  return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * One kind's file: the confirmed rows, one per line, oldest first so the
 * file reads as a record. The id marker is what a str_replace can name
 * unambiguously; the content is sanitized the way every user string that
 * reaches the model is.
 */
export function renderMemoryFile(kind: MemoryKind, rows: CoachMemoryRow[]): string {
  const mine = oldestFirst(rows.filter(r => r.kind === kind));
  if (mine.length === 0) return `(no ${memoryFileLabel(kind)} confirmed yet)`;
  return mine.map(r => `- [id:${r.id}] ${sanitizeInlineText(r.content, MEMORY_CONTENT_MAX)}`).join('\n');
}

/** The directory listing: every file, with how many facts it holds. */
export function renderMemoryDirectory(rows: CoachMemoryRow[]): string {
  const lines = MEMORY_KINDS.map(kind => {
    const n = rows.filter(r => r.kind === kind).length;
    return `${pathForKind(kind)} (${n} ${n === 1 ? 'fact' : 'facts'})`;
  });
  return `${MEMORY_ROOT}\n${lines.join('\n')}`;
}

export interface MemoryViewResult {
  text: string;
  isError: boolean;
}

/**
 * The `view` command: the directory for /memories, a kind's file for one of
 * the five paths, an error the model can correct for anything else. Never
 * throws — a database failure is a result, not a broken turn.
 */
export async function viewPath(supabase: Admin, userId: string, path: unknown): Promise<MemoryViewResult> {
  const root = isMemoryRoot(path);
  const kind = kindForPath(path);
  if (!root && !kind) {
    return { text: `No such memory file: ${String(path)}. Files: ${MEMORY_ROOT}, ${memoryPathList()}`, isError: true };
  }
  let rows: CoachMemoryRow[];
  try {
    rows = await listConfirmed(supabase, userId);
  } catch (err) {
    console.warn('[api/chat] memory view failed:', err instanceof Error ? err.message : err);
    return { text: 'Memory is unavailable right now.', isError: true };
  }
  return { text: root ? renderMemoryDirectory(rows) : renderMemoryFile(kind as MemoryKind, rows), isError: false };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Where a confirmed write came from, stamped on the rows it inserts. */
export interface MemoryWriteSource {
  sourceKind?: 'chat' | 'reflection' | 'user';
  sourceId?: string | null;
}

const RENAME_REFUSED =
  `Memory files are fixed — ${Object.values(MEMORY_FILES).join(', ')} under ${MEMORY_ROOT} — and cannot be renamed. ` +
  'Write the fact into the file for its kind instead.';

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Rows of `kind` a str_replace's old_str names: by id marker, then exact text, then a unique substring. */
function matchRows(rows: CoachMemoryRow[], oldStr: string): CoachMemoryRow[] {
  const id = memoryIdOf(oldStr);
  if (id) return rows.filter(r => r.id.toLowerCase() === id);
  const needle = normalized(memoryLines(oldStr)[0] ?? oldStr);
  if (!needle) return [];
  const exact = rows.filter(r => normalized(r.content) === needle);
  if (exact.length) return exact;
  return rows.filter(r => normalized(r.content).includes(needle));
}

/**
 * Insert confirmed rows for `lines`, honouring the per-user cap. Returns the
 * rows written and how many lines were dropped at the cap.
 */
async function insertFacts(
  supabase: Admin,
  userId: string,
  kind: MemoryKind,
  lines: string[],
  live: number,
  source: MemoryWriteSource,
): Promise<{ rows: CoachMemoryRow[]; dropped: number } | { error: string }> {
  const room = Math.max(0, MEMORY_CONFIRMED_CAP - live);
  if (room === 0) {
    return { error: `Memory is full (${MEMORY_CONFIRMED_CAP} confirmed facts). Forget something first — str_replace a line with an empty new_str, or delete a file.` };
  }
  const kept = lines.slice(0, room);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('coach_memory')
    .insert(kept.map(content => ({
      user_id: userId,
      kind,
      content,
      source_kind: source.sourceKind ?? 'chat',
      source_id: source.sourceId ?? null,
      confirmed_at: now,
    })))
    .select('*');
  if (error) return { error: `Memory write failed: ${error.message}` };
  return { rows: (data ?? []) as CoachMemoryRow[], dropped: lines.length - kept.length };
}

function cappedNote(dropped: number): string {
  return dropped > 0 ? ` ${dropped} more not saved: memory holds ${MEMORY_CONFIRMED_CAP} confirmed facts and is full.` : '';
}

function tooLong(lines: string[]): string | null {
  const over = lines.filter(l => l.length > MEMORY_CONTENT_MAX);
  if (!over.length) return null;
  return `Each fact must be ${MEMORY_CONTENT_MAX} characters or fewer (${over.length} ${over.length === 1 ? 'line is' : 'lines are'} longer). Shorten and retry.`;
}

/**
 * Apply one CONFIRMED memory write and describe the outcome for the model.
 * The click is the confirmation, so every row lands with confirmed_at set.
 *
 *   create / insert  → one confirmed row per non-empty line of the text
 *                      (insert_line is ignored: a file is a set of facts,
 *                      not a document with positions)
 *   str_replace      → the one matched row is superseded by a row per line of
 *                      new_str; an empty new_str forgets it (archives)
 *   delete           → every confirmed row of that kind is archived
 *   rename           → refused: the five files are fixed
 *
 * Never throws: a bad path, an ambiguous match or a database error come
 * back as text the model can act on.
 */
export async function applyMemoryCommand(
  supabase: Admin,
  userId: string,
  input: unknown,
  source: MemoryWriteSource = {},
): Promise<string> {
  const cmd = parseMemoryCommand(input);
  if (!cmd) return 'Not a memory command. Use create, str_replace, insert, delete or view with a /memories path.';
  if (cmd.command === 'view') return 'view is a read; nothing to confirm.';
  if (cmd.command === 'rename') return RENAME_REFUSED;

  if (isMemoryRoot(cmd.path)) {
    return cmd.command === 'delete'
      ? `Refusing to delete ${MEMORY_ROOT} itself. Delete one file, or str_replace a line with an empty new_str to forget one fact.`
      : `${MEMORY_ROOT} is a directory. Write into one of its files: ${memoryPathList()}`;
  }
  const kind = kindForPath(cmd.path);
  if (!kind) return `No such memory file: ${cmd.path}. Files: ${memoryPathList()}`;
  const file = memoryFileLabel(kind);

  let live: CoachMemoryRow[];
  try {
    live = await listConfirmed(supabase, userId);
  } catch (err) {
    console.warn('[api/coach-tool] memory read failed:', err instanceof Error ? err.message : err);
    return 'Memory is unavailable right now; nothing was changed.';
  }

  if (cmd.command === 'create' || cmd.command === 'insert') {
    const lines = memoryLines(cmd.command === 'create' ? cmd.file_text : cmd.insert_text);
    if (lines.length === 0) return `Nothing to remember: the text for ${file} had no non-empty line.`;
    const long = tooLong(lines);
    if (long) return long;
    const written = await insertFacts(supabase, userId, kind, lines, live.length, source);
    if ('error' in written) return written.error;
    const n = written.rows.length;
    return `Remembered ${n} ${n === 1 ? 'fact' : 'facts'} in ${pathForKind(kind)}: ${written.rows.map(r => `[id:${r.id}] ${r.content}`).join('; ')}.${cappedNote(written.dropped)}`;
  }

  if (cmd.command === 'delete') {
    const mine = live.filter(r => r.kind === kind);
    if (mine.length === 0) return `${pathForKind(kind)} was already empty.`;
    const { error } = await supabase
      .from('coach_memory')
      .update({ archived_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('id', mine.map(r => r.id));
    if (error) return `Memory write failed: ${error.message}`;
    return `Forgot ${mine.length} ${file} ${mine.length === 1 ? 'fact' : 'facts'}.`;
  }

  // str_replace
  const matches = matchRows(live.filter(r => r.kind === kind), cmd.old_str);
  if (matches.length === 0) {
    return `No fact in ${pathForKind(kind)} matches old_str. Current contents:\n${renderMemoryFile(kind, live)}`;
  }
  if (matches.length > 1) {
    return `old_str matches ${matches.length} facts in ${pathForKind(kind)}; name one by its [id:…] marker:\n${matches.map(r => `- [id:${r.id}] ${r.content}`).join('\n')}`;
  }
  const target = matches[0];
  const lines = memoryLines(cmd.new_str);
  const now = new Date().toISOString();
  if (lines.length === 0) {
    const { error } = await supabase
      .from('coach_memory')
      .update({ archived_at: now })
      .eq('user_id', userId)
      .eq('id', target.id);
    if (error) return `Memory write failed: ${error.message}`;
    return `Forgot: ${target.content}`;
  }
  const long = tooLong(lines);
  if (long) return long;
  // The superseded row leaves the live set, so it does not count against the cap.
  const written = await insertFacts(supabase, userId, kind, lines, live.length - 1, source);
  if ('error' in written) return written.error;
  const replacement = written.rows[0];
  // Two statements, no transaction (PostgREST), so the retirement is
  // CONDITIONAL — only a row that is still live can be superseded — and a
  // retirement that does not land (a concurrent edit got there first, or the
  // update errored) archives the rows just written, so the file never holds
  // both the old fact and its replacement, and two racing edits leave one
  // winner rather than two live replacements.
  const retired = await supabase
    .from('coach_memory')
    .update({ superseded_by: replacement.id })
    .eq('user_id', userId)
    .eq('id', target.id)
    .is('superseded_by', null)
    .is('archived_at', null)
    .select('id');
  const landed = !retired.error && (retired.data?.length ?? 0) > 0;
  if (!landed) {
    await supabase
      .from('coach_memory')
      .update({ archived_at: now })
      .eq('user_id', userId)
      .in('id', written.rows.map(r => r.id));
    return retired.error
      ? `Memory write failed: ${retired.error.message}. Nothing was changed.`
      : `That fact was already changed by another edit; nothing was changed. Current contents:\n${renderMemoryFile(kind, await listConfirmed(supabase, userId).catch(() => live))}`;
  }
  return `Updated memory in ${pathForKind(kind)}: "${target.content}" → ${written.rows.map(r => `[id:${r.id}] ${r.content}`).join('; ')}.${cappedNote(written.dropped)}`;
}
