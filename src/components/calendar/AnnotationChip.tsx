import { X } from 'lucide-react';
import { chipText, maxSeverity, type CoachAnnotation } from '../../lib/coach/annotations';
import './annotations.css';

interface MarkerProps {
  notes: readonly CoachAnnotation[];
  /** Where the marker sits, for tests: 'event' (a chip or week block) or 'day' (a week header). */
  testId: 'event-annotation-marker' | 'day-annotation-marker';
}

// One dot however many notes, where a pill would not fit: a 22px event chip,
// a week block, a week-view day header. Coloured by the worst note; the
// bodies read in the tooltip. It is not a control — dismissing happens on
// the chips in the day view — so it sits inside whatever button owns the row
// without stealing its click.
export function AnnotationMarker({ notes, testId }: MarkerProps) {
  const severity = maxSeverity(notes);
  if (!severity) return null;
  return (
    <span
      className={`annotation-marker annotation-marker--${severity}`}
      data-testid={testId}
      data-severity={severity}
      role="img"
      aria-label={`${notes.length} coach note${notes.length === 1 ? '' : 's'}`}
      title={notes.map(n => n.body).join('\n')}
    />
  );
}

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
