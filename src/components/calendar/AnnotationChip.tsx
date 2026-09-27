import { X } from 'lucide-react';
import { chipText, type CoachAnnotation } from '../../lib/coach/annotations';
import './annotations.css';

interface Props {
  annotation: CoachAnnotation;
  onDismiss?: (id: string) => void;
  /** Full body, wrapping — the block strip. Default is the calendar pill:
   *  one line, the first ~40 characters, the whole note on hover. */
  full?: boolean;
}

// One coach note, as a pill coloured by severity. Sits inside clickable
// things — a day cell whose click opens the day, an event chip whose click
// opens the workout — so both of its handlers stop propagation: dismissing a
// note must not also open what it was pinned to.
export default function AnnotationChip({ annotation, onDismiss, full = false }: Props) {
  const text = full ? annotation.body : chipText(annotation.body);
  return (
    <div
      className={`annotation-chip annotation-chip--${annotation.severity}${full ? ' annotation-chip--full' : ''}`}
      data-testid="annotation-chip"
      data-severity={annotation.severity}
      title={annotation.body}
      onClick={e => e.stopPropagation()}
    >
      <span className="annotation-chip__text">{text}</span>
      {onDismiss && (
        <button
          type="button"
          className="annotation-chip__dismiss"
          onClick={e => { e.stopPropagation(); onDismiss(annotation.id); }}
          aria-label="Dismiss coach note"
          title="Dismiss"
        >
          <X size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
