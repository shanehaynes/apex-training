import { useEffect, useState } from 'react';
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { Announcements, KeyboardCoordinateGetter, Modifier, UniqueIdentifier } from '@dnd-kit/core';

// Shared pieces of the two exercise reorderers: the editor's cards
// (modal/EventExerciseEditor) and the live tracker's exercises
// (tracker/TrackerView). Both sort one section at a time with dnd-kit, which
// keeps scrolling while a dragged item rests near the scroll container's
// edge and counts that scroll in the drop target, so an item can travel past
// everything that was on screen when it was picked up.

/** Items only move within their own column. */
export const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * One arrow press, one place. dnd-kit's stock getter lines the held item's
 * top edge up with the next item's, and the drop target is then the item
 * whose centre is nearest the held item's centre. With cards of different
 * heights those disagree: a tall card topped onto a short one centres nearer
 * the card after it, so the target does not change and the press is lost.
 * This getter steps through the list's order from the current target and
 * centres the held item on the next one, which closest-centre then picks
 * exactly. Other keys move nothing; the list is vertical.
 */
export const stepKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const step = event.code === 'ArrowUp' ? -1 : event.code === 'ArrowDown' ? 1 : 0;
  if (!step) return undefined;
  event.preventDefault();
  const { active, over, collisionRect, droppableRects } = context;
  const items: UniqueIdentifier[] | undefined = active?.data.current?.sortable?.items;
  if (!active || !collisionRect || !items) return undefined;
  const from = items.indexOf(over?.id ?? active.id);
  const to = (from >= 0 ? from : items.indexOf(active.id)) + step;
  const target = to >= 0 && to < items.length ? droppableRects.get(items[to]) : undefined;
  if (!target) return undefined;
  return { x: collisionRect.left, y: target.top + target.height / 2 - collisionRect.height / 2 };
};

/**
 * Pointer serves mouse and touch alike (the grip sets touch-action: none, so
 * a finger on it drags instead of scrolling); the keyboard picks up with
 * Space, moves with the arrows, drops with Space and cancels with Escape.
 */
export function useReorderSensors() {
  return useSensors(
    useSensor(PointerSensor),
    // Instant, not smooth: when the next place is past the middle of the
    // scroll container, the keyboard sensor scrolls the list under the held
    // item instead of moving it, and the target only updates once the scroll
    // lands. A smooth scroll is still running when a quick second press
    // reads the target, so that press steps from the old place and is lost.
    useSensor(KeyboardSensor, { coordinateGetter: stepKeyboardCoordinates, scrollBehavior: 'auto' }),
  );
}

/**
 * While something is being dragged, Escape cancels the drag (dnd-kit listens
 * for it on the document) and must not also reach an overlay underneath —
 * the workout modal's Escape closes the exercise editor and drops its unsaved
 * edits. A capture listener claims the key first; dnd-kit still sees it, and
 * useModalChrome skips a claimed key. Returns the setter the caller wires to
 * the DndContext's drag start, end and cancel.
 */
export function useClaimEscapeWhileDragging(): (dragging: boolean) => void {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const claim = (e: KeyboardEvent) => { if (e.key === 'Escape') e.preventDefault(); };
    document.addEventListener('keydown', claim, true);
    return () => document.removeEventListener('keydown', claim, true);
  }, [dragging]);
  return setDragging;
}

/** Screen readers hear the exercise and its place, never an entry id. */
export function reorderAnnouncements(items: ReadonlyArray<{ id: string; name: string }>): Announcements {
  const name = (id: UniqueIdentifier) => items.find(i => i.id === id)?.name ?? 'Exercise';
  const place = (id: UniqueIdentifier) => `position ${items.findIndex(i => i.id === id) + 1} of ${items.length}`;
  return {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, ${place(active.id)}.`,
    onDragOver: ({ active, over }) => over
      ? `${name(active.id)} is over ${place(over.id)}.`
      : `${name(active.id)} is outside the list.`,
    onDragEnd: ({ active, over }) => over
      ? `${name(active.id)} dropped at ${place(over.id)}.`
      : `${name(active.id)} dropped back in place.`,
    onDragCancel: ({ active }) => `Move cancelled. ${name(active.id)} is back in place.`,
  };
}
