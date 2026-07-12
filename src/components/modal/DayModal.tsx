import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Plus, CheckCircle2, Clock } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { getWorkoutColor } from '../../utils/workoutColors';
import { formatEventTime, formatDuration } from '../../utils/dateHelpers';

/**
 * Day overview modal: opened by clicking a day number in the month grid.
 * Lists the day's events; selecting one swaps in the WorkoutModal (the
 * SELECT_EVENT reducer arm clears selectedDay).
 */
export default function DayModal() {
  const { state, dispatch } = useCalendar();
  const { getEventsForDate } = useSchedule();
  const day = state.selectedDay;
  const close = () => dispatch({ type: 'CLEAR_DAY' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

  if (!day) return null;

  const date = parseISO(day);
  const events = getEventsForDate(date);

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={close}
      >
        <motion.div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="day-modal-title"
          initial={{ opacity: 0, scale: 0.94, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          onClick={e => e.stopPropagation()}
        >
          <div className="day-modal__header">
            <div className="day-modal__header-info">
              <span className="day-modal__weekday">{format(date, 'EEEE')}</span>
              <h2 id="day-modal-title" className="day-modal__date">{format(date, 'MMMM d, yyyy')}</h2>
              <span className="day-modal__count">
                {events.length === 0 ? 'No workouts' : `${events.length} workout${events.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="day-modal__header-actions">
              <button
                className="day-modal__add"
                onClick={() => dispatch({ type: 'OPEN_COMPOSER', payload: day })}
              >
                <Plus size={15} strokeWidth={2} /> Add event
              </button>
              <button className="modal-close" onClick={close} aria-label="Close">
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>
          </div>

          <div className="day-modal__list">
            {events.length === 0 && (
              <p className="day-modal__empty">Nothing scheduled — a rest day, or room for something new.</p>
            )}
            {events.map(event => {
              const color = getWorkoutColor(event.type);
              return (
                <button
                  key={event.id}
                  className={`day-modal__event${event.isCompleted ? ' day-modal__event--done' : ''}`}
                  style={{ borderLeft: `3px solid ${color.solid}` }}
                  onClick={() => dispatch({ type: 'SELECT_EVENT', payload: event })}
                >
                  <div className="day-modal__event-main">
                    <span className="day-modal__event-badge" style={{ background: color.solid }}>
                      {color.label}
                    </span>
                    <span className="day-modal__event-title">{event.title}</span>
                    {event.subtitle && <span className="day-modal__event-subtitle">{event.subtitle}</span>}
                  </div>
                  <div className="day-modal__event-side">
                    <span className="day-modal__event-time">
                      <Clock size={12} strokeWidth={1.5} />
                      {event.startTime ? formatEventTime(event.startTime, event.endTime) : formatDuration(event.estimatedDuration)}
                    </span>
                    {event.isCompleted && (
                      <span className="day-modal__event-check" style={{ color: color.solid }}>
                        <CheckCircle2 size={15} strokeWidth={2} />
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
