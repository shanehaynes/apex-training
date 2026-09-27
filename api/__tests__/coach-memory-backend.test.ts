import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyMemoryCommand, listConfirmed, renderMemoryDirectory, renderMemoryFile, toPromptEntries, viewPath } from '../_lib/coach/memory';
import { MEMORY_CONFIRMED_CAP } from '../../src/lib/coach/memory';
import type { CoachMemoryRow } from '../../src/lib/db/types';

// The Postgres backend of the coach's memory over an in-memory stand-in for
// the service-role client: the stand-in applies the filters the code sends,
// so a query that forgets `.eq('user_id', …)` or the live-row predicate
// shows up as the wrong rows, not as a passing test.

const U = 'user-123';
const OTHER = 'user-999';

type Row = CoachMemoryRow;

let rows: Row[];
let seq: number;
let failing: string | null;

function row(over: Partial<Row> & Pick<Row, 'kind' | 'content'>): Row {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    user_id: U,
    confidence: null,
    source_kind: 'chat',
    source_id: null,
    created_at: new Date(Date.UTC(2026, 8, 27, 0, 0, seq)).toISOString(),
    confirmed_at: '2026-09-27T00:00:00.000Z',
    superseded_by: null,
    archived_at: null,
    ...over,
  };
}

type Filter = (r: Row) => boolean;

function makeDb() {
  return {
    from(table: string) {
      expect(table).toBe('coach_memory');
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: unknown;
      const filters: Filter[] = [];
      let order: { col: keyof Row; asc: boolean } | null = null;
      let limit: number | null = null;
      let count = false;
      let head = false;
      const b: Record<string, unknown> = {};
      b.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (op === 'select') { count = !!opts?.count; head = !!opts?.head; }
        return b;
      };
      b.insert = (p: unknown) => { op = 'insert'; payload = Array.isArray(p) ? p : [p]; return b; };
      b.update = (p: unknown) => { op = 'update'; payload = p; return b; };
      b.eq = (col: keyof Row, v: unknown) => { filters.push(r => r[col] === v); return b; };
      b.is = (col: keyof Row, v: unknown) => { filters.push(r => r[col] === v); return b; };
      b.not = (col: keyof Row, _op: string, v: unknown) => { filters.push(r => r[col] !== v); return b; };
      b.in = (col: keyof Row, vs: unknown[]) => { filters.push(r => vs.includes(r[col])); return b; };
      b.order = (col: keyof Row, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return b; };
      b.limit = (n: number) => { limit = n; return b; };
      const run = async () => {
        if (failing) return { data: null, error: { message: failing }, count: null };
        if (op === 'insert') {
          const inserted = (payload as Array<Partial<Row>>).map(p => row({ kind: 'note', content: '', ...p } as Row));
          rows.push(...inserted);
          return { data: inserted, error: null, count: null };
        }
        let matched = rows.filter(r => filters.every(f => f(r)));
        if (op === 'update') {
          for (const r of matched) Object.assign(r, payload);
          return { data: matched, error: null, count: null };
        }
        if (order) {
          const { col, asc } = order;
          matched = [...matched].sort((a, c) => String(a[col]).localeCompare(String(c[col])) * (asc ? 1 : -1));
        }
        if (limit !== null) matched = matched.slice(0, limit);
        return { data: head ? null : matched, error: null, count: count ? matched.length : null };
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject);
      b.maybeSingle = async () => { const r = await run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }; };
      b.single = b.maybeSingle;
      return b;
    },
  } as never;
}

function live(): Row[] {
  return rows.filter(r => r.user_id === U && r.confirmed_at && !r.archived_at && !r.superseded_by);
}

beforeEach(() => {
  seq = 0;
  failing = null;
  rows = [
    row({ kind: 'injury', content: 'left shoulder: avoid overhead pressing until cleared' }),
    row({ kind: 'goal', content: 'Rainier June 2027' }),
    row({ kind: 'preference', content: 'prefers morning sessions' }),
    row({ kind: 'preference', content: 'hates the rower', archived_at: '2026-09-20T00:00:00.000Z' }),
    row({ kind: 'note', content: 'proposed, unconfirmed', confirmed_at: null, source_kind: 'reflection' }),
    row({ kind: 'goal', content: 'someone else\'s goal', user_id: OTHER }),
  ];
});

describe('listConfirmed', () => {
  it('returns only this user\'s live rows — confirmed, not archived, not superseded — newest first', async () => {
    const out = await listConfirmed(makeDb(), U);
    expect(out.map(r => r.content)).toEqual(['prefers morning sessions', 'Rainier June 2027', 'left shoulder: avoid overhead pressing until cleared']);
    expect(toPromptEntries(out)).toEqual([
      { kind: 'preference', content: 'prefers morning sessions' },
      { kind: 'goal', content: 'Rainier June 2027' },
      { kind: 'injury', content: 'left shoulder: avoid overhead pressing until cleared' },
    ]);
  });

  it('throws on a database error, for the caller to degrade', async () => {
    failing = 'relation "coach_memory" does not exist';
    await expect(listConfirmed(makeDb(), U)).rejects.toThrow(/does not exist/);
  });
});

describe('rendering and view', () => {
  it('renders a file as one line per fact, oldest first, with the id marker, sanitized', async () => {
    rows.push(row({ kind: 'injury', content: '<script>right knee</script>: no deep squats' }));
    const text = renderMemoryFile('injury', live());
    expect(text.split('\n')).toEqual([
      `- [id:${rows[0].id}] left shoulder: avoid overhead pressing until cleared`,
      `- [id:${rows.at(-1)!.id}] script>right knee/script>: no deep squats`,
    ]);
    expect(renderMemoryFile('history', live())).toBe('(no history confirmed yet)');
  });

  it('renders the directory with a count per file', () => {
    expect(renderMemoryDirectory(live())).toBe([
      '/memories',
      '/memories/injuries.md (1 fact)',
      '/memories/preferences.md (1 fact)',
      '/memories/goals.md (1 fact)',
      '/memories/history.md (0 facts)',
      '/memories/notes.md (0 facts)',
    ].join('\n'));
  });

  it('viewPath answers the root, a file, and an unknown path with an error the model can correct', async () => {
    const db = makeDb();
    expect(await viewPath(db, U, '/memories')).toEqual({ text: renderMemoryDirectory(live()), isError: false });
    expect(await viewPath(db, U, 'memories/goals.md')).toEqual({ text: `- [id:${rows[1].id}] Rainier June 2027`, isError: false });
    const bad = await viewPath(db, U, '/memories/diary.md');
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('/memories/injuries.md');
    const missing = await viewPath(db, U, undefined);
    expect(missing.isError).toBe(true);
  });

  it('viewPath never throws: a database failure is an error result', async () => {
    failing = 'boom';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await viewPath(makeDb(), U, '/memories')).toEqual({ text: 'Memory is unavailable right now.', isError: true });
    warn.mockRestore();
  });
});

describe('applyMemoryCommand — create and insert', () => {
  it('create appends one CONFIRMED row per non-empty line, stamped with the source', async () => {
    const out = await applyMemoryCommand(makeDb(), U, {
      command: 'create', path: '/memories/injuries.md',
      file_text: '# Injuries\n- right knee: no deep squats\n\n* ankle: taped for court sports',
    }, { sourceKind: 'chat', sourceId: '11111111-2222-4333-8444-555555555555' });
    const added = rows.slice(-2);
    expect(added.map(r => [r.kind, r.content, r.source_kind, r.source_id, r.user_id])).toEqual([
      ['injury', 'right knee: no deep squats', 'chat', '11111111-2222-4333-8444-555555555555', U],
      ['injury', 'ankle: taped for court sports', 'chat', '11111111-2222-4333-8444-555555555555', U],
    ]);
    for (const r of added) expect(r.confirmed_at).not.toBeNull();
    expect(out).toContain('Remembered 2 facts in /memories/injuries.md');
    expect(out).toContain(`[id:${added[0].id}] right knee: no deep squats`);
  });

  it('insert is a create at the kind, whatever insert_line says', async () => {
    const out = await applyMemoryCommand(makeDb(), U, { command: 'insert', path: '/memories/history.md', insert_line: 99, insert_text: 'first 5.12a: Sept 2026' });
    expect(rows.at(-1)).toMatchObject({ kind: 'history', content: 'first 5.12a: Sept 2026', source_kind: 'chat' });
    expect(out).toContain('Remembered 1 fact in /memories/history.md');
  });

  it('refuses an empty text, a fact over 500 characters, an unknown file and the root, writing nothing', async () => {
    const before = rows.length;
    const db = makeDb();
    expect(await applyMemoryCommand(db, U, { command: 'create', path: '/memories/notes.md', file_text: '\n\n' })).toContain('Nothing to remember');
    expect(await applyMemoryCommand(db, U, { command: 'create', path: '/memories/notes.md', file_text: 'x'.repeat(501) })).toContain('500 characters or fewer');
    expect(await applyMemoryCommand(db, U, { command: 'create', path: '/memories/diary.md', file_text: 'x' })).toContain('No such memory file');
    expect(await applyMemoryCommand(db, U, { command: 'create', path: '/memories', file_text: 'x' })).toContain('is a directory');
    expect(await applyMemoryCommand(db, U, { command: 'rename', old_path: '/memories/notes.md', new_path: '/memories/diary.md' })).toContain('cannot be renamed');
    expect(await applyMemoryCommand(db, U, { command: 'view', path: '/memories' })).toContain('view is a read');
    expect(await applyMemoryCommand(db, U, { nope: true })).toContain('Not a memory command');
    expect(rows.length).toBe(before);
  });

  it(`caps confirmed rows at ${MEMORY_CONFIRMED_CAP} per user and says so`, async () => {
    for (let i = live().length; i < MEMORY_CONFIRMED_CAP - 1; i++) rows.push(row({ kind: 'note', content: `note ${i}` }));
    const out = await applyMemoryCommand(makeDb(), U, { command: 'create', path: '/memories/notes.md', file_text: 'fits\ndoes not fit' });
    expect(live()).toHaveLength(MEMORY_CONFIRMED_CAP);
    expect(rows.at(-1)!.content).toBe('fits');
    expect(out).toContain('Remembered 1 fact');
    expect(out).toContain('1 more not saved');
    const full = await applyMemoryCommand(makeDb(), U, { command: 'create', path: '/memories/notes.md', file_text: 'one more' });
    expect(full).toContain('Memory is full');
    expect(live()).toHaveLength(MEMORY_CONFIRMED_CAP);
  });

  it('never throws: a failing insert comes back as text', async () => {
    const db = makeDb() as unknown as { from: (table: string) => unknown };
    // The read succeeds, the write fails.
    const original = db.from;
    let calls = 0;
    db.from = (table: string) => { calls += 1; if (calls === 2) failing = 'disk full'; return original(table); };
    const out = await applyMemoryCommand(db as never, U, { command: 'create', path: '/memories/notes.md', file_text: 'x' });
    expect(out).toContain('Memory write failed: disk full');
  });
});

describe('applyMemoryCommand — str_replace and delete', () => {
  it('str_replace supersedes the matched row with a new one, matched by content', async () => {
    const goal = rows[1];
    const out = await applyMemoryCommand(makeDb(), U, { command: 'str_replace', path: '/memories/goals.md', old_str: 'Rainier June 2027', new_str: 'Rainier July 2027' });
    const replacement = rows.at(-1)!;
    expect(replacement).toMatchObject({ kind: 'goal', content: 'Rainier July 2027' });
    expect(replacement.confirmed_at).not.toBeNull();
    expect(goal.superseded_by).toBe(replacement.id);
    expect(goal.archived_at).toBeNull();
    expect(live().map(r => r.content)).not.toContain('Rainier June 2027');
    expect(out).toContain('Updated memory in /memories/goals.md: "Rainier June 2027" →');
  });

  it('str_replace matches by the [id:…] marker a view showed, and by a unique substring', async () => {
    const db = makeDb();
    const injury = rows[0];
    await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/injuries.md', old_str: `- [id:${injury.id}] whatever the model retyped`, new_str: 'left shoulder: cleared for overhead pressing' });
    expect(injury.superseded_by).toBe(rows.at(-1)!.id);
    const pref = rows[2];
    await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/preferences.md', old_str: 'morning', new_str: 'prefers evening sessions' });
    expect(pref.superseded_by).toBe(rows.at(-1)!.id);
  });

  it('str_replace with an empty new_str forgets (archives) the fact', async () => {
    const goal = rows[1];
    const out = await applyMemoryCommand(makeDb(), U, { command: 'str_replace', path: '/memories/goals.md', old_str: 'Rainier June 2027', new_str: '' });
    expect(goal.archived_at).not.toBeNull();
    expect(goal.superseded_by).toBeNull();
    expect(out).toBe('Forgot: Rainier June 2027');
  });

  it('str_replace refuses no match and an ambiguous match, showing the file, and touches nothing', async () => {
    rows.push(row({ kind: 'note', content: 'knee feels fine' }), row({ kind: 'note', content: 'knee brace ordered' }));
    const snapshot = JSON.stringify(rows);
    const db = makeDb();
    const none = await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/goals.md', old_str: 'Denali', new_str: 'x' });
    expect(none).toContain('No fact in /memories/goals.md matches old_str');
    expect(none).toContain('Rainier June 2027');
    const many = await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/notes.md', old_str: 'knee', new_str: 'x' });
    expect(many).toContain('matches 2 facts');
    expect(many).toContain('[id:');
    // A match in another kind's file does not count.
    const wrongFile = await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/notes.md', old_str: 'Rainier June 2027', new_str: 'x' });
    expect(wrongFile).toContain('No fact');
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('str_replace never matches an archived, superseded, unconfirmed or other user\'s row', async () => {
    const db = makeDb();
    expect(await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/preferences.md', old_str: 'hates the rower', new_str: 'x' })).toContain('No fact');
    expect(await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/notes.md', old_str: 'proposed, unconfirmed', new_str: 'x' })).toContain('No fact');
    expect(await applyMemoryCommand(db, U, { command: 'str_replace', path: '/memories/goals.md', old_str: 'someone else\'s goal', new_str: 'x' })).toContain('No fact');
  });

  it('delete archives every live row of that kind, and only that kind, for this user', async () => {
    rows.push(row({ kind: 'goal', content: 'Denali 2028' }));
    const out = await applyMemoryCommand(makeDb(), U, { command: 'delete', path: '/memories/goals.md' });
    expect(out).toBe('Forgot 2 goals facts.');
    expect(live().map(r => r.kind)).toEqual(['injury', 'preference']);
    expect(rows.find(r => r.user_id === OTHER)!.archived_at).toBeNull();
    expect(await applyMemoryCommand(makeDb(), U, { command: 'delete', path: '/memories/goals.md' })).toBe('/memories/goals.md was already empty.');
    expect(await applyMemoryCommand(makeDb(), U, { command: 'delete', path: '/memories' })).toContain('Refusing to delete /memories itself');
  });

  it('a database failure on the read leaves everything unchanged and says so', async () => {
    failing = 'down';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await applyMemoryCommand(makeDb(), U, { command: 'delete', path: '/memories/goals.md' })).toBe('Memory is unavailable right now; nothing was changed.');
    warn.mockRestore();
  });
});
