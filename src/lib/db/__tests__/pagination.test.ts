import { describe, expect, it, vi } from 'vitest';
import { fetchAllRows } from '../pagination';

const fullPage = () => Array.from({ length: 1000 }, (_, i) => ({ i }));

describe('fetchAllRows abort', () => {
  it('stops after the in-flight page and rejects, rather than resolving with page one', async () => {
    const abort = new AbortController();
    const page = vi.fn(async () => {
      abort.abort(); // the view unmounts while page one is in flight
      return { data: fullPage(), error: null };
    });
    await expect(fetchAllRows('history', page, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing once already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const page = vi.fn(async () => ({ data: [], error: null }));
    await expect(fetchAllRows('history', page, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(page).not.toHaveBeenCalled();
  });

  it('drains every page when never aborted', async () => {
    const abort = new AbortController();
    const pages = [fullPage(), [{ i: 1000 }]];
    const page = vi.fn(async () => ({ data: pages.shift() ?? [], error: null }));
    await expect(fetchAllRows('history', page, abort.signal)).resolves.toHaveLength(1001);
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  });
});
