import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Calendar, Clock, MapPin, CheckCircle2, Circle, TrendingUp, Heart, Ruler } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { getWorkoutColor } from '../../utils/workoutColors';
import { formatEventTime, formatDuration } from '../../utils/dateHelpers';
import ExerciseCard from './ExerciseCard';
import type { Exercise } from '../../types/workout';

const DIFFICULTY_LABELS = ['', 'Easy', 'Moderate', 'Challenging', 'Hard', 'Maximal'];

export default function WorkoutModal() {
  const { state, dispatch } = useCalendar();
  const { events, toggleCompletion } = useSchedule();
  const event = state.selectedEvent;
  if (!event) return null;

  // Always read live completion state from ScheduleContext rather than the
  // snapshot stored in CalendarContext's selectedEvent.
  const isCompleted = events.find(e => e.id === event.id)?.isCompleted ?? event.isCompleted;

  const color = getWorkoutColor(event.type);
  const close = () => dispatch({ type: 'CLEAR_EVENT' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

  const isStrava = event.source === 'strava';

  const sections: { label: string; items: Exercise[] }[] = [
    ...(event.warmup?.length ? [{ label: 'Warm-Up', items: event.warmup }] : []),
    { label: 'Main Work', items: event.exercises },
    ...(event.cooldown?.length ? [{ label: 'Cool-Down', items: event.cooldown }] : []),
  ];

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
          aria-labelledby="modal-title"
          initial={{ opacity: 0, scale: 0.94, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          {event.coverImageUrl ? (
            <div className="modal-cover">
              <img src={event.coverImageUrl} alt="" className="modal-cover__img" />
              <div className="modal-cover__overlay" />
              <div className="modal-cover__content">
                <span className="modal-type-badge" style={{ background: color.solid }}>{color.label}</span>
                <h2 id="modal-title" className="modal-title">{event.title}</h2>
                {event.subtitle && <p className="modal-subtitle">{event.subtitle}</p>}
              </div>
              <button className="modal-close modal-close--over-image" onClick={close} aria-label="Close"><X size={18} strokeWidth={1.5} /></button>
            </div>
          ) : (
            <div className="modal-header" style={{ borderLeft: `4px solid ${color.solid}` }}>
              <div className="modal-header__top">
                <span className="modal-type-badge" style={{ background: color.solid }}>{color.label}</span>
                <button className="modal-close" onClick={close} aria-label="Close"><X size={18} strokeWidth={1.5} /></button>
              </div>
              <h2 id="modal-title" className="modal-title">{event.title}</h2>
              {event.subtitle && <p className="modal-subtitle">{event.subtitle}</p>}
            </div>
          )}

          {/* Difficulty & duration */}
          <div className="modal-meta-strip">
            <span className="modal-meta-item">
              <Calendar size={14} strokeWidth={1.5} />
              {format(parseISO(event.date), 'EEEE, MMM d')}
            </span>
            {event.startTime && (
              <span className="modal-meta-item">
                <Clock size={14} strokeWidth={1.5} />
                {formatEventTime(event.startTime, event.endTime)}
              </span>
            )}
            <span className="modal-meta-item">
              <Clock size={14} strokeWidth={1.5} />
              {formatDuration(event.estimatedDuration)}
            </span>
            {event.location && (
              <span className="modal-meta-item">
                <MapPin size={14} strokeWidth={1.5} />
                {event.location}
              </span>
            )}
          </div>

          {/* Difficulty dots */}
          <div className="modal-difficulty">
            {Array.from({ length: 5 }, (_, i) => (
              <span
                key={i}
                className="modal-difficulty__dot"
                style={{ background: i < event.difficulty ? color.solid : 'var(--border-subtle)' }}
              />
            ))}
            <span className="modal-difficulty__label">{DIFFICULTY_LABELS[event.difficulty]}</span>
          </div>

          {/* Completion toggle — only for scheduled events */}
          {!isStrava && (
            <div className="modal-completion">
              <button
                className={`modal-completion__btn${isCompleted ? ' modal-completion__btn--done' : ''}`}
                onClick={() => toggleCompletion(event.id)}
                style={isCompleted ? { borderColor: color.solid, color: color.solid } : {}}
              >
                {isCompleted
                  ? <><CheckCircle2 size={15} strokeWidth={2} /> Completed</>
                  : <><Circle size={15} strokeWidth={1.5} /> Mark as Complete</>
                }
              </button>
            </div>
          )}

          <div className="modal-body">
            {/* Description */}
            <p className="modal-description">{event.description}</p>

            {/* Strava metrics */}
            {isStrava && event.stravaData && (
              <div className="strava-metrics">
                <div className="strava-metrics__header">
                  <span className="strava-metrics__source">Synced from Strava</span>
                </div>
                <div className="strava-metrics__grid">
                  {event.stravaData.distance > 0 && (
                    <div className="strava-metric">
                      <Ruler size={14} strokeWidth={1.5} />
                      <span className="strava-metric__value">
                        {(event.stravaData.distance / 1000).toFixed(2)} km
                      </span>
                      <span className="strava-metric__label">Distance</span>
                    </div>
                  )}
                  <div className="strava-metric">
                    <Clock size={14} strokeWidth={1.5} />
                    <span className="strava-metric__value">
                      {formatDuration(Math.round(event.stravaData.elapsed_time / 60))}
                    </span>
                    <span className="strava-metric__label">Time</span>
                  </div>
                  {event.stravaData.total_elevation_gain > 0 && (
                    <div className="strava-metric">
                      <TrendingUp size={14} strokeWidth={1.5} />
                      <span className="strava-metric__value">
                        {Math.round(event.stravaData.total_elevation_gain)} m
                      </span>
                      <span className="strava-metric__label">Elevation</span>
                    </div>
                  )}
                  {event.stravaData.average_heartrate && (
                    <div className="strava-metric">
                      <Heart size={14} strokeWidth={1.5} />
                      <span className="strava-metric__value">
                        {Math.round(event.stravaData.average_heartrate)} bpm
                        {event.stravaData.max_heartrate && (
                          <span className="strava-metric__sub"> / {Math.round(event.stravaData.max_heartrate)} max</span>
                        )}
                      </span>
                      <span className="strava-metric__label">Heart Rate</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Exercise sections — only for scheduled events with exercises */}
            {!isStrava && sections.map(section => (
              <div key={section.label} className="modal-section">
                <div className="modal-section__header">
                  <span className="modal-section__line" />
                  <span className="modal-section__label">{section.label}</span>
                  <span className="modal-section__line" />
                </div>
                {section.items.map(ex => <ExerciseCard key={ex.id} exercise={ex} accentColor={color.solid} />)}
              </div>
            ))}

            {/* Tags */}
            {event.tags.length > 0 && (
              <div className="modal-tags">
                {event.tags.map(tag => (
                  <span key={tag} className="modal-tag">{tag}</span>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
