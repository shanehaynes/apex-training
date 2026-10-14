import { describe, it, expect } from 'vitest';
import { upsertByShape } from '../_lib/upsertByShape';

describe('upsertByShape', () => {
  it('sends one batch per distinct key set, regardless of key order', async () => {
    const batches: Record<string, unknown>[][] = [];
    const result = await upsertByShape(
      [{ a: 1, b: 1 }, { a: 2 }, { b: 3, a: 3 }],
      async batch => { batches.push(batch); return { error: null }; },
    );
    expect(result.error).toBeNull();
    expect(batches).toEqual([[{ a: 1, b: 1 }, { b: 3, a: 3 }], [{ a: 2 }]]);
  });

  it('runs batches in order and stops at the first error', async () => {
    const sent: unknown[] = [];
    const result = await upsertByShape(
      [{ a: 1 }, { b: 1 }, { c: 1 }],
      async batch => {
        sent.push(batch[0]);
        return { error: 'b' in batch[0] ? { message: 'boom', code: '23502' } : null };
      },
    );
    expect(result.error).toEqual({ message: 'boom', code: '23502' });
    expect(sent).toEqual([{ a: 1 }, { b: 1 }]);
  });
});
