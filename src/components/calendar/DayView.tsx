import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format, isToday } from 'date-fns';
import { CheckCircle2, Circle } from 'lucide-react';
import { buildWeekDays, toDateString } from '../../utils/dateHelpers';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useSchedule } from '../../context/ScheduleContext';
import { useCalendar } from '../../context/CalendarContext';
import type { WorkoutEvent } from '../../types/workout';

interface Props {
  currentDate: Date;
}

export default function DayView({ currentDate }: Props) {
  const { getEventsForDate, toggleCompletion } = useSchedule();
  const { dispatch } = useCalendar();
  const weekDays = useMemo(() => buildWeekDays(currentDate), [currentDate]);
  const events = useMemo(() => getEventsForDate(currentDate), [getEventsForDate, currentDate]);

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
        {isToday(currentDate) && <span className="day-view__today-badge">Today</span>}
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
  const isStrava = (event as WorkoutEvent & { source?: string }).source === 'strava';

  return (
    <div
      className={`day-event-card${event.isCompleted ? ' day-event-card--done' : ''}`}
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
        disabled={isStrava}
      >
        {event.isCompleted
          ? <CheckCircle2 size={22} strokeWidth={2} />
          : <Circle size={22} strokeWidth={1.5} />
        }
      </button>
    </div>
  );
}
