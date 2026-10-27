import { describe, it, expect } from 'vitest';
import { closestCenter } from '@dnd-kit/core';
import type { ClientRect, KeyboardCoordinateGetter, UniqueIdentifier } from '@dnd-kit/core';
import { stepKeyboardCoordinates } from '../sortable';

// Twelve cards of uneven height, as the editor shows them (an exercise with
// more fields is taller), stacked with a 10px gap. The last one is tall.
const HEIGHTS = [120, 300, 120, 140, 120, 300, 120, 140, 120, 120, 120, 320];
const ids = HEIGHTS.map((_, i) => `e${i}`);
const rects = new Map<UniqueIdentifier, ClientRect>();
let top = 0;
HEIGHTS.forEach((height, i) => {
  rects.set(ids[i], { top, bottom: top + height, height, left: 0, right: 300, width: 300 });
  top += height + 10;
});

/** Pick up the card at `from`, press `key` `presses` times; the index it would drop at. */
function dropIndexAfter(getter: KeyboardCoordinateGetter, from: number, key: string, presses: number): number {
  const active = { id: ids[from], data: { current: { sortable: { containerId: 'list', index: from, items: ids } } } };
  const containers = ids.map(id => ({ id, disabled: false, data: { current: { sortable: { containerId: 'list', index: ids.indexOf(id), items: ids } } }, node: { current: null } }));
  let collisionRect = rects.get(active.id)!;
  let over = { id: active.id as UniqueIdentifier };
  for (let i = 0; i < presses; i++) {
    const event = { code: key, preventDefault() {} } as unknown as KeyboardEvent;
    const context = {
      active, over, collisionRect, droppableRects: rects, scrollableAncestors: [],
      droppableContainers: { getEnabled: () => containers, get: (id: UniqueIdentifier) => containers.find(c => c.id === id) },
    };
    const next = getter(event, { active: active.id, context, currentCoordinates: { x: collisionRect.left, y: collisionRect.top } } as never);
    if (!next) break;
    const { height, left, right, width } = collisionRect;
    collisionRect = { height, left, right, width, top: next.y, bottom: next.y + height };
    const hit = closestCenter({ active, collisionRect, droppableRects: rects, droppableContainers: containers, pointerCoordinates: null } as never)[0];
    over = { id: hit.id };
  }
  return ids.indexOf(over.id as string);
}

describe('stepKeyboardCoordinates', () => {
  it('moves the held card one place per arrow press, whatever the card heights', () => {
    for (let presses = 1; presses <= 11; presses++) {
      expect(dropIndexAfter(stepKeyboardCoordinates, 11, 'ArrowUp', presses)).toBe(11 - presses);
    }
    for (let presses = 1; presses <= 10; presses++) {
      expect(dropIndexAfter(stepKeyboardCoordinates, 1, 'ArrowDown', presses)).toBe(1 + presses);
    }
  });

  it('stops at either end of the list', () => {
    expect(dropIndexAfter(stepKeyboardCoordinates, 11, 'ArrowUp', 20)).toBe(0);
    expect(dropIndexAfter(stepKeyboardCoordinates, 0, 'ArrowDown', 20)).toBe(11);
  });
});
