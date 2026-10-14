/**
 * Select a just-focused field's text on the next frame, so the first
 * keystroke replaces a committed ghost value instead of appending to it —
 * but only while the field still has focus. Chromium's select() focuses the
 * element, so a frame that lands after the user has moved on (a long task
 * between the tap and the paint) would pull focus back and send the next
 * field's typing into this one: a session note saved as a set's weight.
 */
export function selectOnNextFrame(el: HTMLInputElement, frame: (cb: () => void) => unknown = requestAnimationFrame) {
  frame(() => {
    if (el.ownerDocument.activeElement === el) el.select();
  });
}
