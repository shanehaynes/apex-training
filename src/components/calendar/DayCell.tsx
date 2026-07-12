import { isToday, isSameMonth, format } from 'date-fns';
import EventChip from './EventChip';
import { useCalendar } from '../../context/CalendarContext';
import type { WorkoutEvent } from '../../types/workout';

interface Props {
  date: Date;
  currentMonth: Date;
  events: WorkoutEvent[];
}

const MAX_VISIBLE = 3;

export default function DayCell({ date, currentMonth, events }: Props) {
  const { dispatch } = useCalendar();
  const today = isToday(date);
  const inMonth = isSameMonth(date, currentMonth);

  const visible = events.slice(0, MAX_VISIBLE);
  const overflow = events.length - MAX_VISIBLE;

  const openDay = () => dispatch({ type: 'SELECT_DAY', payload: format(date, 'yyyy-MM-dd') });

  return (
    <div className={`day-cell ${!inMonth ? 'day-cell--adjacent' : ''}`}>
      <div className="day-cell__header">
        <button
          className={`day-cell__date-btn day-cell__date ${today ? 'day-cell__date--today' : ''}`}
          onClick={openDay}
          aria-label={`View ${format(date, 'MMMM d')}`}
        >
          {date.getDate()}
        </button>
      </div>
      <div className="day-cell__events">
        {visible.map(event => (
          <EventChip key={event.id} event={event} />
        ))}
        {overflow > 0 && (
          <button className="day-cell__overflow" onClick={openDay}>+{overflow} more</button>
        )}
      </div>
    </div>
  );
}
