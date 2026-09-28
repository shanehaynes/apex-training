import { describe, it, expect, vi } from 'vitest';
import { useCoachReachable } from '../useCoachReachable';

// The hook is a function of two media queries; with useMediaQuery answered
// per query string it needs no renderer, so its three ranges are proved
// directly: desktop (rail shown), tablet (rail hidden, no tab), phone (tab).

const width = vi.hoisted(() => ({ px: 1280 }));

vi.mock('../useMediaQuery', () => ({
  useMediaQuery: (query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1]);
    return width.px <= max;
  },
}));

describe('useCoachReachable', () => {
  it('desktop (over 1024px): the rail is on screen', () => {
    width.px = 1280;
    expect(useCoachReachable()).toBe(true);
    width.px = 1025;
    expect(useCoachReachable()).toBe(true);
  });

  it('tablet (769–1024px): the rail is hidden and there is no Coach tab', () => {
    width.px = 1024;
    expect(useCoachReachable()).toBe(false);
    width.px = 900;
    expect(useCoachReachable()).toBe(false);
    width.px = 769;
    expect(useCoachReachable()).toBe(false);
  });

  it('phone (768px and below): the Coach tab brings the pane up', () => {
    width.px = 768;
    expect(useCoachReachable()).toBe(true);
    width.px = 390;
    expect(useCoachReachable()).toBe(true);
  });
});
