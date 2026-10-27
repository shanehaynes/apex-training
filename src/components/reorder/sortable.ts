import { useEffect, useState } from 'react';
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { Announcements, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

// Shared pieces of the two exercise reorderers: the editor's cards
// (modal/EventExerciseEditor) and the live tracker's exercises
// (tracker/TrackerView). Both sort one section at a time with dnd-kit, which
// keeps scrolling while a dragged item rests near the scroll container's
// edge and counts that scroll in the drop target, so an item can travel past
// everything that was on screen when it was picked up.

/** Items only move within their own column. */
export const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * Pointer serves mouse and touch alike (the grip sets touch-action: none, so
 * a finger on it drags instead of scrolling); the keyboard picks up with
 * Space, moves with the arrows, drops with Space and cancels with Escape.
 */
export function useReorderSensors() {
  return useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
