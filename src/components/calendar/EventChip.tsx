import { getWorkoutColor } from '../../utils/workoutColors';
import type { WorkoutEvent } from '../../types/workout';
import { useCalendar } from '../../context/CalendarContext';

interface Props {
  event: WorkoutEvent;
}

export default function EventChip({ event }: Props) {
  const { dispatch } = useCalendar();
  const color = getWorkoutColor(event.type);

  const label = event.startTime
    ? `${event.startTime.replace(' AM', '').replace(' PM', '')} · ${event.title}`
    : event.title;

  return (
    <button
      className="event-chip"
      style={{
        background: color.light,
        borderLeft: `3px solid ${color.solid}`,
      }}
      onClick={e => { e.stopPropagation(); dispatch({ type: 'SELECT_EVENT', payload: event }); }}
      aria-label={`${event.title} on ${event.date}`}
    >
      <span className="event-chip__dot" style={{ background: color.solid }} />
      <span className="event-chip__label">{label}</span>
    </button>
  );
}
