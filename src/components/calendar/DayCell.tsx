import { memo } from 'react';
import { isSameMonth, format } from 'date-fns';
import { isToday } from '../../lib/clock';
import EventChip from './EventChip';
import AnnotationChip from './AnnotationChip';
import { useCalendar } from '../../context/calendar';
import { useAnnotations } from '../../context/annotations';
import type { WorkoutEvent } from '../../types/workout';

interface Props {
  date: Date;
  currentMonth: Date;
  events: WorkoutEvent[];
}

const MAX_VISIBLE = 3;
/** Coach notes shown before the cell collapses the rest to a count. */
const MAX_ANNOTATIONS = 2;

// memo pays off because ScheduleContext hands out referentially stable
// per-day event arrays — an unrelated day's change skips this cell entirely.
// The annotations context is read inside, so a note change re-renders every
// cell once (its value identity changes) and nothing otherwise.
export default memo(DayCell);

function DayCell({ date, currentMonth, events }: Props) {
  const { dispatch } = useCalendar();
  const { byDay, dismiss } = useAnnotations();
  const today = isToday(date);
  const inMonth = isSameMonth(date, currentMonth);
  const dateKey = format(date, 'yyyy-MM-dd');

  const visible = events.slice(0, MAX_VISIBLE);
  const overflow = events.length - MAX_VISIBLE;

  const notes = byDay(dateKey);
  const visibleNotes = notes.slice(0, MAX_ANNOTATIONS);
  const moreNotes = notes.length - MAX_ANNOTATIONS;

  const openDay = () => dispatch({ type: 'SELECT_DAY', payload: dateKey });

  return (
    <div className={`day-cell ${!inMonth ? 'day-cell--adjacent' : ''}`} onClick={openDay}>
      <div className="day-cell__header">
        <button
          className={`day-cell__date-btn day-cell__date ${today ? 'day-cell__date--today' : ''}`}
          onClick={e => { e.stopPropagation(); openDay(); }}
          aria-label={`View ${format(date, 'MMMM d')}`}
        >
          {date.getDate()}
        </button>
      </div>
      {notes.length > 0 && (
        <div className="day-cell__annotations" data-testid="day-annotations">
          {visibleNotes.map(note => (
            <AnnotationChip key={note.id} annotation={note} onDismiss={dismiss} />
          ))}
          {moreNotes > 0 && (
            <button
              type="button"
              className="day-cell__annotations-more"
              title={notes.slice(MAX_ANNOTATIONS).map(n => n.body).join('\n')}
              onClick={e => { e.stopPropagation(); openDay(); }}
            >
              +{moreNotes} more note{moreNotes === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
      <div className="day-cell__events">
        {visible.map(event => (
          <EventChip key={event.id} event={event} />
        ))}
        {overflow > 0 && (
          <button className="day-cell__overflow" onClick={e => { e.stopPropagation(); openDay(); }}>+{overflow} more</button>
        )}
      </div>
    </div>
  );
}
