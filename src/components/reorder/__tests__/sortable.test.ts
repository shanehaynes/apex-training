import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { closestCenter } from '@dnd-kit/core';
import type { ClientRect, KeyboardCoordinateGetter, SensorProps, UniqueIdentifier } from '@dnd-kit/core';
import { GripKeyboardSensor, stepKeyboardCoordinates } from '../sortable';
import type { GripKeyboardSensorOptions } from '../sortable';

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

// Vitest runs in Node, which has EventTarget and Event but no DOM, so the
// sensor gets a stand-in. dnd-kit finds the document from the pick-up's
// target (a node that is an HTMLElement of its window), the window from the
// document's defaultView or, for the document itself, the global, and reads a
// key only when it is that window's KeyboardEvent. The document counts the
// keydown listeners left on it.
class FakeKeyboardEvent extends Event {
  readonly code: string;
  constructor(code: string) {
    super('keydown', { cancelable: true });
    this.code = code;
  }
}
class FakeDocument extends EventTarget {
  readonly nodeType = 9;
  readonly ownerDocument = null;
  readonly defaultView: FakeWindow;
  readonly keydownListeners = new Set<unknown>();
  constructor(defaultView: FakeWindow) {
    super();
    this.defaultView = defaultView;
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === 'keydown') this.keydownListeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (type === 'keydown') this.keydownListeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
}
class FakeElement extends EventTarget {
  readonly nodeType = 1;
  readonly ownerDocument: FakeDocument;
  constructor(ownerDocument: FakeDocument) {
    super();
    this.ownerDocument = ownerDocument;
  }
}
class FakeWindow extends EventTarget {
  readonly [Symbol.toStringTag] = 'Window';
  readonly Document = FakeDocument;
  readonly HTMLElement = FakeElement;
  readonly KeyboardEvent = FakeKeyboardEvent;
}

/** Space on a grip has picked an item up; dnd-kit's timer to arm the keys has not run. */
function pickUp() {
  const win = new FakeWindow();
  const doc = new FakeDocument(win);
  const grip = new FakeElement(doc);
  vi.stubGlobal('window', win);
  const props = {
    active: 'e0',
    activeNode: { id: 'e0', key: 'e0', node: { current: null }, activatorNode: { current: grip }, data: { current: {} } },
    event: { target: grip },
    context: { current: { active: null, collisionRect: null, droppableRects: new Map(), scrollableAncestors: [] } },
    options: { coordinateGetter: stepKeyboardCoordinates, scrollBehavior: 'auto', onFocusLeave: vi.fn() },
    onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn(), onAbort: vi.fn(), onPending: vi.fn(),
  };
  const sensor = new GripKeyboardSensor(props as unknown as SensorProps<GripKeyboardSensorOptions>);
  /** Presses a key on the document; whether anything claimed it. */
  const press = (code: string) => {
    const event = new FakeKeyboardEvent(code);
    doc.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { sensor, win, doc, props, press };
}

describe('GripKeyboardSensor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reads keys once dnd-kit arms them, and lets go of them when the move ends', () => {
    const { doc, props, press } = pickUp();
    vi.runAllTimers();
    expect(press('ArrowUp')).toBe(true);
    expect(press('Space')).toBe(true);
    expect(props.onEnd).toHaveBeenCalledTimes(1);
    expect(doc.keydownListeners.size).toBe(0);
    expect(press('Space')).toBe(false);
  });

  it.each<[string, (picked: ReturnType<typeof pickUp>) => void]>([
    ['focus leaves the grip', ({ doc }) => doc.dispatchEvent(new Event('focusin'))],
    ['the window resizes', ({ win }) => win.dispatchEvent(new Event('resize'))],
  ])('leaves the keys alone when the move is cancelled before they are armed: %s', (_, cancel) => {
    const picked = pickUp();
    cancel(picked);
    expect(picked.props.onCancel).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(['ArrowUp', 'Space', 'Enter', 'Escape'].map(code => picked.press(code))).toEqual([false, false, false, false]);
    expect(picked.props.onEnd).not.toHaveBeenCalled();
    expect(picked.props.onCancel).toHaveBeenCalledTimes(1);
    expect(picked.doc.keydownListeners.size).toBe(0);
  });
});
