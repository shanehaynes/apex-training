import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Calendar, Clock, MapPin } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { getWorkoutColor } from '../../utils/workoutColors';
import { formatEventTime, formatDuration } from '../../utils/dateHelpers';
import ExerciseCard from './ExerciseCard';
import type { Exercise } from '../../types/workout';

const DIFFICULTY_LABELS = ['', 'Easy', 'Moderate', 'Challenging', 'Hard', 'Maximal'];

export default function WorkoutModal() {
  const { state, dispatch } = useCalendar();
  const event = state.selectedEvent;
  if (!event) return null;

  const color = getWorkoutColor(event.type);
  const close = () => dispatch({ type: 'CLEAR_EVENT' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

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

          <div className="modal-body">
            {/* Description */}
            <p className="modal-description">{event.description}</p>

            {/* Exercise sections */}
            {sections.map(section => (
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
