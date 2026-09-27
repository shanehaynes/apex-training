import { describe, it, expect } from 'vitest';
import {
  describeMemoryWrite, isMemoryRoot, isMemoryView, kindForPath, memoryIdOf, memoryLines, memoryReadChip,
  memoryToolSchema, memoryWriteLabel, MEMORY_KINDS, normalizeMemoryPath, parseMemoryCommand, pathForKind,
} from '../memory';

// The vocabulary the model, the server and the confirm card share: five
// files under /memories, six commands of which only `view` is a read, and
// the labels a card shows from the command alone.

describe('paths', () => {
  it('maps each kind to one file and back, tolerant of a missing slash, a missing .md and case', () => {
    for (const kind of MEMORY_KINDS) expect(kindForPath(pathForKind(kind))).toBe(kind);
    expect(kindForPath('/memories/injuries.md')).toBe('injury');
    expect(kindForPath('memories/injuries.md')).toBe('injury');
    expect(kindForPath('/memories/injuries')).toBe('injury');
    expect(kindForPath('/memories/Goals.md/')).toBe('goal');
    expect(kindForPath('/memories/diary.md')).toBeNull();
    expect(kindForPath('/memories')).toBeNull();
    expect(kindForPath('/etc/passwd')).toBeNull();
    expect(kindForPath(42)).toBeNull();
  });

  it('knows the root and normalizes slashes', () => {
    expect(isMemoryRoot('/memories')).toBe(true);
    expect(isMemoryRoot('/memories/')).toBe(true);
    expect(isMemoryRoot('memories')).toBe(true);
    expect(isMemoryRoot('/memories/notes.md')).toBe(false);
    expect(normalizeMemoryPath('memories\\notes.md')).toBe('/memories/notes.md');
    expect(normalizeMemoryPath('//memories//notes.md/')).toBe('/memories/notes.md');
    expect(normalizeMemoryPath(null)).toBeNull();
  });

  it('is the API\'s typed memory tool, not a custom schema', () => {
    expect(memoryToolSchema).toEqual({ type: 'memory_20250818', name: 'memory' });
  });
});

describe('commands', () => {
  it('parses the six commands and refuses anything else', () => {
    expect(parseMemoryCommand({ command: 'view', path: '/memories' })).toEqual({ command: 'view', path: '/memories' });
    expect(parseMemoryCommand({ command: 'create', path: '/memories/goals.md', file_text: 'x' })).toEqual({ command: 'create', path: '/memories/goals.md', file_text: 'x' });
    expect(parseMemoryCommand({ command: 'str_replace', path: 'p', old_str: 'a', new_str: 'b' })).toEqual({ command: 'str_replace', path: 'p', old_str: 'a', new_str: 'b' });
    expect(parseMemoryCommand({ command: 'insert', path: 'p', insert_line: 2, insert_text: 't' })).toEqual({ command: 'insert', path: 'p', insert_line: 2, insert_text: 't' });
    expect(parseMemoryCommand({ command: 'delete', path: 'p' })).toEqual({ command: 'delete', path: 'p' });
    expect(parseMemoryCommand({ command: 'rename', old_path: 'a', new_path: 'b' })).toEqual({ command: 'rename', old_path: 'a', new_path: 'b' });
    // Missing payload fields read as empty; a missing path or command is not a command.
    expect(parseMemoryCommand({ command: 'create', path: 'p' })).toEqual({ command: 'create', path: 'p', file_text: '' });
    expect(parseMemoryCommand({ command: 'create' })).toBeNull();
    expect(parseMemoryCommand({ command: 'format', path: 'p' })).toBeNull();
    expect(parseMemoryCommand({ path: 'p' })).toBeNull();
    expect(parseMemoryCommand(null)).toBeNull();
    expect(parseMemoryCommand('view')).toBeNull();
  });

  it('isMemoryView is true for view alone — with no input, a write is assumed', () => {
    expect(isMemoryView({ command: 'view', path: '/memories' })).toBe(true);
    expect(isMemoryView({ command: 'create', path: '/memories/notes.md', file_text: 'x' })).toBe(false);
    expect(isMemoryView({ command: 'delete', path: '/memories/notes.md' })).toBe(false);
    expect(isMemoryView(undefined)).toBe(false);
    expect(isMemoryView({})).toBe(false);
  });
});

describe('lines', () => {
  it('takes one fact per non-empty line, stripping bullets, numbering and the id marker', () => {
    const text = [
      '# Injuries',
      '- [id:11111111-2222-4333-8444-555555555555] left shoulder: no overhead pressing',
      '* prefers   morning sessions ',
      '3. goal: Rainier June 2027',
      '',
      '   ',
      'plain line',
    ].join('\n');
    expect(memoryLines(text)).toEqual([
      'left shoulder: no overhead pressing',
      'prefers morning sessions',
      'goal: Rainier June 2027',
      'plain line',
    ]);
    expect(memoryLines('')).toEqual([]);
    expect(memoryLines(undefined)).toEqual([]);
    expect(memoryLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('reads the id marker off a rendered line', () => {
    expect(memoryIdOf('- [id:11111111-2222-4333-8444-555555555555] left shoulder')).toBe('11111111-2222-4333-8444-555555555555');
    expect(memoryIdOf('[ID:11111111-2222-4333-8444-555555555555]')).toBe('11111111-2222-4333-8444-555555555555');
    expect(memoryIdOf('left shoulder')).toBeNull();
    expect(memoryIdOf('[id:nope]')).toBeNull();
  });
});

describe('labels and previews', () => {
  it('create → "Remember: <first line>" with a count for the rest, and the facts as the preview', () => {
    const d = describeMemoryWrite({ command: 'create', path: '/memories/injuries.md', file_text: '- left shoulder: avoid overhead pressing until cleared\n- right knee: no deep squats' });
    expect(d.action).toBe('remember');
    expect(d.label).toBe('Remember: left shoulder: avoid overhead pressing until cleared (+1 more)');
    expect(d.file).toBe('injuries');
    expect(d.before).toEqual([]);
    expect(d.after).toEqual(['left shoulder: avoid overhead pressing until cleared', 'right knee: no deep squats']);
    expect(memoryWriteLabel({ command: 'create', path: '/memories/goals.md', file_text: 'Rainier June 2027' })).toBe('Remember: Rainier June 2027');
  });

  it('insert is a create at the kind; the line number is ignored', () => {
    const d = describeMemoryWrite({ command: 'insert', path: '/memories/preferences.md', insert_line: 7, insert_text: 'prefers morning sessions' });
    expect(d).toMatchObject({ action: 'remember', label: 'Remember: prefers morning sessions', file: 'preferences', after: ['prefers morning sessions'] });
  });

  it('str_replace → "Update memory: old → new", or "Forget: old" for an empty new_str', () => {
    const update = describeMemoryWrite({ command: 'str_replace', path: '/memories/goals.md', old_str: '- [id:11111111-2222-4333-8444-555555555555] Rainier June 2027', new_str: 'Rainier July 2027' });
    expect(update).toMatchObject({ action: 'update', label: 'Update memory: Rainier June 2027 → Rainier July 2027', file: 'goals', before: ['Rainier June 2027'], after: ['Rainier July 2027'] });
    const forget = describeMemoryWrite({ command: 'str_replace', path: '/memories/goals.md', old_str: 'Rainier June 2027', new_str: '' });
    expect(forget).toMatchObject({ action: 'forget', label: 'Forget: Rainier June 2027', before: ['Rainier June 2027'], after: [] });
    // An old_str that is only the id marker still names the fact.
    const byId = describeMemoryWrite({ command: 'str_replace', path: '/memories/goals.md', old_str: '[id:11111111-2222-4333-8444-555555555555]', new_str: '' });
    expect(byId.action).toBe('forget');
  });

  it('delete a file → "Forget: every <file> memory"; the root, rename and a bad path are refused', () => {
    expect(describeMemoryWrite({ command: 'delete', path: '/memories/notes.md' })).toMatchObject({ action: 'forget', label: 'Forget: every notes memory', file: 'notes' });
    expect(describeMemoryWrite({ command: 'delete', path: '/memories' }).action).toBe('refused');
    expect(describeMemoryWrite({ command: 'rename', old_path: '/memories/notes.md', new_path: '/memories/diary.md' })).toMatchObject({ action: 'refused', label: 'Update memory: rename is not supported' });
    expect(describeMemoryWrite({ command: 'create', path: '/memories/diary.md', file_text: 'x' }).label).toBe('Update memory: unknown file /memories/diary.md');
    expect(describeMemoryWrite({ command: 'create', path: '/memories/notes.md', file_text: '\n\n' }).action).toBe('refused');
    expect(describeMemoryWrite({ command: 'view', path: '/memories' }).action).toBe('refused');
    expect(describeMemoryWrite(undefined).label).toBe('Update memory: malformed command');
  });

  it('bounds and strips model text in the label, never in the fact list', () => {
    const long = 'x'.repeat(200);
    const d = describeMemoryWrite({ command: 'create', path: '/memories/notes.md', file_text: `<b>${long}` });
    expect(d.label.length).toBeLessThan(100);
    expect(d.label.endsWith('…')).toBe(true);
    expect(d.label).not.toContain('<');
    expect(d.after[0]).toBe(`<b>${long}`);
  });

  it('memoryReadChip names the file, or just the tool', () => {
    expect(memoryReadChip({ command: 'view', path: '/memories/injuries.md' })).toBe('Checked: memory (injuries)');
    expect(memoryReadChip({ command: 'view', path: '/memories' })).toBe('Checked: memory');
    expect(memoryReadChip(null)).toBe('Checked: memory');
  });
});
