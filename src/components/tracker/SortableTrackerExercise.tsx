import type { CSSProperties, ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import PositionPicker from '../reorder/PositionPicker';

/**
 * One tracker exercise as an item of its section's sortable list. The grip
 * and the position picker are handed to the exercise as its `reorder` slot,
 * so they sit in its header before the name; the rest of the card never
 * starts a drag, so typing reps or tapping a ghost value is unaffected.
 */
export default function SortableTrackerExercise({ id, name, index, count, onMove, children }: {
  id: string;
  name: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  children: (reorder: ReactNode) => ReactNode;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id });
  const style: CSSProperties = {
    // Translate, not Transform: exercises differ in height (set rows, cardio
    // fields, notes), and a scale would stretch the dragged one.
    transform: CSS.Translate.toString(transform),
    transition,
  };
  const reorder = count > 1 ? (
    <span className="tracker-reorder">
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="tracker-reorder__grip"
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${name}`}
      >
        <GripVertical size={14} strokeWidth={1.5} />
      </button>
      <PositionPicker index={index} count={count} name={name} onMove={onMove} />
    </span>
  ) : null;
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`tracker-sortable${isDragging ? ' tracker-sortable--dragging' : ''}`}
    >
      {children(reorder)}
    </li>
  );
}
