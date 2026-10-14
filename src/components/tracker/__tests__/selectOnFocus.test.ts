import { describe, it, expect, vi } from 'vitest';
import { selectOnNextFrame } from '../selectOnFocus';

// No DOM environment here: a field is its select() and the document's
// activeElement, which is all the guard reads.
function setup() {
  const doc = { activeElement: null as unknown };
  const el = { ownerDocument: doc, select: vi.fn() } as unknown as HTMLInputElement & { select: ReturnType<typeof vi.fn> };
  const frames: Array<() => void> = [];
  const frame = (cb: () => void) => frames.push(cb);
  return { doc, el, frames, frame };
}

describe('selectOnNextFrame', () => {
  it('selects the tapped field on the next frame while it still has focus', () => {
    const { doc, el, frames, frame } = setup();
    doc.activeElement = el;
    selectOnNextFrame(el, frame);
    expect(el.select).not.toHaveBeenCalled();
    frames.forEach(f => f());
    expect(el.select).toHaveBeenCalledOnce();
  });

  it('leaves focus where the user went when the frame lands late', () => {
    const { doc, el, frames, frame } = setup();
    doc.activeElement = el;
    selectOnNextFrame(el, frame);
    const note = {};
    doc.activeElement = note; // a ghost weight tapped, then the session note
    frames.forEach(f => f());
    expect(el.select).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(note);
  });
});
