import { CheckCircle2, Circle } from 'lucide-react';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useCalendar } from '../../context/calendar';
import { useSchedule } from '../../context/schedule';
import { useAnnotations } from '../../context/annotations';
import { maxSeverity } from '../../lib/coach/annotations';
import type { WorkoutEvent } from '../../types/workout';
import './annotations.css';

interface Props {
  event: WorkoutEvent;
}

export default function EventChip({ event }: Props) {
  const { dispatch } = useCalendar();
  const { toggleCompletion } = useSchedule();
  const { byEvent } = useAnnotations();
  const color = getWorkoutColor(event.type);
  // One marker however many notes: the chip is 22px tall, so the notes read
  // in the tooltip rather than in the row. Coloured by the worst of them.
  const notes = byEvent(event.id);
  const noteSeverity = maxSeverity(notes);
  const label = event.startTime
    ? `${event.startTime.replace(' AM', '').replace(' PM', '')} · ${event.title}`
    : event.title;

  return (
    <div
      className={`event-chip${event.isCompleted ? ' event-chip--done' : ''}`}
      style={{ background: color.light, borderLeft: `3px solid ${color.solid}` }}
    >
      <button
        className="event-chip__main"
        onClick={e => { e.stopPropagation(); dispatch({ type: 'SELECT_EVENT', payload: event }); }}
        aria-label={`${event.title} on ${event.date}`}
      >
        <span className="event-chip__dot" style={{ background: color.solid }} />
        <span className="event-chip__label">{label}</span>
        {noteSeverity && (
          <span
            className={`annotation-marker annotation-marker--${noteSeverity}`}
            data-testid="event-annotation-marker"
            data-severity={noteSeverity}
            role="img"
            aria-label={`${notes.length} coach note${notes.length === 1 ? '' : 's'}`}
            title={notes.map(n => n.body).join('\n')}
          />
        )}
      </button>
      <button
        className="event-chip__check"
        onClick={e => { e.stopPropagation(); toggleCompletion(event.id); }}
        aria-label={event.isCompleted ? 'Mark incomplete' : 'Mark complete'}
        title={event.isCompleted ? 'Mark incomplete' : 'Mark complete'}
      >
        {event.isCompleted
          ? <CheckCircle2 size={13} strokeWidth={2} />
          : <Circle size={13} strokeWidth={1.5} />
        }
      </button>
    </div>
  );
}
