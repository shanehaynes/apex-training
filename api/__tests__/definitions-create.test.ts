import { describe, it, expect, vi } from 'vitest';
import { createDefinition } from '../_lib/services/definitions.js';

// The insert, and the mutation log it writes on success, against a fake admin
// client whose insert answers what each case needs.
function admin(insertError: { code?: string; message: string } | null) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const client = {
    from: (table: string) => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { error: table === 'exercise_definitions' ? insertError : null };
      }),
    }),
  };
  return { client: client as never, inserts };
}

const row = { id: 'pancake-fold', canonical_name: 'Pancake Fold', category: 'stretch' };

describe('createDefinition', () => {
  it('inserts and logs the create', async () => {
    const { client, inserts } = admin(null);
    const result = await createDefinition(client, 'u1', row, 'user');
    expect(result).toEqual({ ok: true, value: { id: 'pancake-fold' } });
    expect(inserts.map(i => i.table)).toEqual(['exercise_definitions', 'definition_mutations_log']);
  });

  it('answers a replayed create (the row already exists) as done, without a second log row', async () => {
    const { client, inserts } = admin({ code: '23505', message: 'duplicate key value violates unique constraint' });
    const result = await createDefinition(client, 'u1', row, 'user');
    expect(result).toEqual({ ok: true, value: { id: 'pancake-fold', existing: true } });
    expect(inserts.map(i => i.table)).toEqual(['exercise_definitions']);
  });

  it('still fails any other insert error', async () => {
    const { client } = admin({ code: '42501', message: 'permission denied' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createDefinition(client, 'u1', row, 'user');
    expect(result.ok).toBe(false);
    spy.mockRestore();
  });
});
