import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format } from 'date-fns';
import { CheckCircle2, Circle } from 'lucide-react';
import { isToday } from '../../lib/clock';
import { buildWeekDays, toDateString } from '../../utils/dateHelpers';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useSchedule } from '../../context/schedule';
import { useCalendar } from '../../context/calendar';
import { useAnnotations } from '../../context/annotations';
import { useTip } from '../../hooks/useTip';
import AnnotationChip from './AnnotationChip';
import type { WorkoutEvent } from '../../types/workout';
import './annotations.css';

interface Props {
  currentDate: Date;
}

// On a phone this is the whole calendar (AppShell forces the day view at
// ≤768px), so it is where the athlete reads and dismisses coach notes: the
// month grid's chips never render there, and the event chip's marker has no
// dismiss of its own. Notes render whole, not cut to a pill — there is room.
export default function DayView({ currentDate }: Props) {
  const { getEventsForDate, toggleCompletion } = useSchedule();
  const { dispatch } = useCalendar();
  const { byDay, dismiss } = useAnnotations();
  const weekDays = useMemo(() => buildWeekDays(currentDate), [currentDate]);
  const events = useMemo(() => getEventsForDate(currentDate), [getEventsForDate, currentDate]);
  const dayNotes = byDay(toDateString(currentDate));
  // The phone's first look at a workout card: its complete circle only
  // makes sense to explain once there is a card to point at.
  useTip('day-complete-circle', events.length > 0);

  return (
    <div className="day-view">
      {/* Mini week strip */}
      <div className="day-view__week-strip">
        {weekDays.map(day => {
          const dayEvents = getEventsForDate(day);
          const isActive = toDateString(day) === toDateString(currentDate);
          const isTodayDay = isToday(day);
          return (
            <button
              key={day.toISOString()}
              className={`day-strip__cell${isActive ? ' day-strip__cell--active' : ''}${isTodayDay ? ' day-strip__cell--today' : ''}`}
              onClick={() => dispatch({ type: 'GO_TO_DATE', payload: day })}
              aria-label={format(day, 'EEEE, MMMM d')}
              aria-pressed={isActive}
            >
              <span className="day-strip__dow">{format(day, 'EEEEE')}</span>
              <span className="day-strip__num">{format(day, 'd')}</span>
              <div className="day-strip__dots">
                {dayEvents.slice(0, 3).map(e => {
                  const c = getWorkoutColor(e.type);
                  return <span key={e.id} className="day-strip__dot" style={{ background: c.solid }} />;
                })}
              </div>
            </button>
          );
        })}
      </div>

      {/* Date header */}
      <div className="day-view__header">
        <div className="day-view__header-date">
          <span className="day-view__dow">{format(currentDate, 'EEEE')}</span>
          <span className="day-view__date-num">{format(currentDate, 'd')}</span>
          <span className="day-view__month">{format(currentDate, 'MMMM yyyy')}</span>
        </div>
        {/* The top nav's Today button doesn't fit on a phone, so the way
            back lives where the badge would be. */}
        {isToday(currentDate) ? (
          <span className="day-view__today-badge">Today</span>
        ) : (
          <button
            className="day-view__today-badge day-view__today-badge--button"
            data-testid="day-view-go-today"
            onClick={() => dispatch({ type: 'GO_TO_TODAY' })}
          >
            Today
          </button>
        )}
      </div>

      {/* Events */}
      <AnimatePresence mode="wait">
        <motion.div
          key={toDateString(currentDate)}
          className="day-view__content"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          {/* Day notes come before the cards and independently of them: a
              rest day with a coach note shows the note above the rest-up line. */}
          {dayNotes.length > 0 && (
            <div className="day-view__annotations" data-testid="day-annotations">
              {dayNotes.map(note => (
                <AnnotationChip key={note.id} annotation={note} onDismiss={dismiss} full />
              ))}
            </div>
          )}
          {events.length === 0 ? (
            <div className="day-view__empty">No workouts scheduled — rest up.</div>
          ) : (
            <div className="day-view__events">
              {events.map(event => (
                <DayEventCard
                  key={event.id}
                  event={event}
                  onToggle={() => toggleCompletion(event.id)}
                  onOpen={() => dispatch({ type: 'SELECT_EVENT', payload: event })}
                />
              ))}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

interface CardProps {
  event: WorkoutEvent;
  onToggle: () => void;
  onOpen: () => void;
}

function DayEventCard({ event, onToggle, onOpen }: CardProps) {
  const color = getWorkoutColor(event.type);
  const { byEvent, dismiss } = useAnnotations();
  const notes = byEvent(event.id);

  return (
    <div
      className={`day-event-card${event.isCompleted ? ' day-event-card--done' : ''}${notes.length > 0 ? ' day-event-card--noted' : ''}`}
      style={{ borderLeft: `4px solid ${color.solid}` }}
    >
      {event.startTime && (
        <div className="day-event-card__time">
          <span>{event.startTime}</span>
          <span className="day-event-card__dur">{event.estimatedDuration}m</span>
        </div>
      )}
      <button className="day-event-card__body" onClick={onOpen} aria-label={`Open ${event.title}`}>
        <div className="day-event-card__info">
          <span className="day-event-card__title">{event.title}</span>
          {event.subtitle && <span className="day-event-card__subtitle">{event.subtitle}</span>}
        </div>
        <span
          className="day-event-card__badge"
          style={{ background: color.solid }}
        >
          {color.label}
        </span>
      </button>
      <button
        className="day-event-card__check"
        onClick={e => { e.stopPropagation(); onToggle(); }}
        aria-label={event.isCompleted ? 'Mark incomplete' : 'Mark complete'}
      >
        {event.isCompleted
          ? <CheckCircle2 size={22} strokeWidth={2} />
          : <Circle size={22} strokeWidth={1.5} />
        }
      </button>
      {/* The body above is a <button>, so the notes — each with a dismiss
          button of its own — wrap onto a row of their own beneath it rather
          than nesting a control inside a control. This is the one place an
          event note can be dismissed (EventChip's marker only points here). */}
      {notes.length > 0 && (
        <div className="day-event-card__annotations" data-testid="event-annotations">
          {notes.map(note => (
            <AnnotationChip key={note.id} annotation={note} onDismiss={dismiss} full />
          ))}
        </div>
      )}
    </div>
  );
}
