import { CheckCircle2, Circle } from 'lucide-react';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import type { WorkoutEvent } from '../../types/workout';

interface Props {
  event: WorkoutEvent;
}

export default function EventChip({ event }: Props) {
  const { dispatch } = useCalendar();
  const { toggleCompletion } = useSchedule();
  const color = getWorkoutColor(event.type);
  const isStrava = event.source === 'strava';

  const label = event.startTime
    ? `${event.startTime.replace(' AM', '').replace(' PM', '')} · ${event.title}`
    : event.title;

  return (
    <div
      className={`event-chip${event.isCompleted ? ' event-chip--done' : ''}${isStrava ? ' event-chip--strava' : ''}`}
      style={{ background: color.light, borderLeft: `3px solid ${color.solid}` }}
    >
      <button
        className="event-chip__main"
        onClick={e => { e.stopPropagation(); dispatch({ type: 'SELECT_EVENT', payload: event }); }}
        aria-label={`${event.title} on ${event.date}`}
      >
        <span className="event-chip__dot" style={{ background: color.solid }} />
        <span className="event-chip__label">{label}</span>
      </button>
      {isStrava ? (
        <span className="event-chip__strava-badge" title="Synced from Strava">✓</span>
      ) : (
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
      )}
    </div>
  );
}
