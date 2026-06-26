import { isToday, isSameMonth } from 'date-fns';
import EventChip from './EventChip';
import type { WorkoutEvent } from '../../types/workout';

interface Props {
  date: Date;
  currentMonth: Date;
  events: WorkoutEvent[];
}

const MAX_VISIBLE = 3;

export default function DayCell({ date, currentMonth, events }: Props) {
  const today = isToday(date);
  const inMonth = isSameMonth(date, currentMonth);

  const visible = events.slice(0, MAX_VISIBLE);
  const overflow = events.length - MAX_VISIBLE;

  return (
    <div className={`day-cell ${!inMonth ? 'day-cell--adjacent' : ''}`}>
      <div className="day-cell__header">
        <span className={`day-cell__date ${today ? 'day-cell__date--today' : ''}`}>
          {date.getDate()}
        </span>
      </div>
      <div className="day-cell__events">
        {visible.map(event => (
          <EventChip key={event.id} event={event} />
        ))}
        {overflow > 0 && (
          <span className="day-cell__overflow">+{overflow} more</span>
        )}
      </div>
    </div>
  );
}
