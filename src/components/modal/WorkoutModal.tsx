import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Calendar, Clock, MapPin, CheckCircle2, Circle, Play } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { getWorkoutColor } from '../../utils/workoutColors';
import { formatEventTime, formatDuration } from '../../utils/dateHelpers';
import { minutesToDisplayTime, timeToMinutes, toDisplayTime, toInputTime } from '../../lib/time';
import { notify } from '../../lib/notify';
import ExerciseCard from './ExerciseCard';
import type { Exercise } from '../../types/workout';

const DIFFICULTY_LABELS = ['', 'Easy', 'Moderate', 'Challenging', 'Hard', 'Maximal'];

export default function WorkoutModal() {
  const { state, dispatch } = useCalendar();
  const { events, toggleCompletion, rescheduleEvent } = useSchedule();
  const event = state.selectedEvent;
  const close = () => dispatch({ type: 'CLEAR_EVENT' });

  const [editingDate, setEditingDate] = useState(false);
  const [editingTime, setEditingTime] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

  if (!event) return null;

  // Always read live state from ScheduleContext rather than the snapshot
  // stored in CalendarContext's selectedEvent — date/time edits and
  // completion toggles land there first.
  const live = events.find(e => e.id === event.id) ?? event;
  const isCompleted = live.isCompleted;

  const commitDate = (value: string) => {
    setEditingDate(false);
    if (!value || value === live.date) return;
    rescheduleEvent(event.id, { date: value });
  };

  const commitStartTime = (value: string) => {
    const stored = toDisplayTime(value);
    if (!stored || stored === live.startTime) return;
    const fields: { startTime: string; endTime?: string } = { startTime: stored };
    // Calendar-style: moving the start drags the end along, preserving the
    // event's duration (capped at the end of the day).
    if (live.startTime && live.endTime) {
      const duration = timeToMinutes(live.endTime) - timeToMinutes(live.startTime);
      fields.endTime = minutesToDisplayTime(timeToMinutes(stored) + duration);
    }
    rescheduleEvent(event.id, fields);
  };

  const commitEndTime = (value: string) => {
    const stored = toDisplayTime(value);
    if (!stored || stored === live.endTime) return;
    if (live.startTime && timeToMinutes(stored) <= timeToMinutes(live.startTime)) {
      notify('End time must be after the start time');
      return;
    }
    rescheduleEvent(event.id, { endTime: stored });
  };

  const color = getWorkoutColor(event.type);

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
            {editingDate ? (
              <span className="modal-meta-item">
                <Calendar size={14} strokeWidth={1.5} />
                <input
                  type="date"
                  className="modal-meta-input"
                  autoFocus
                  defaultValue={live.date}
                  onBlur={e => commitDate(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.stopPropagation(); setEditingDate(false); }
                  }}
                />
              </span>
            ) : (
              <button
                className="modal-meta-item modal-meta-item--edit"
                onClick={() => setEditingDate(true)}
                title="Change date"
              >
                <Calendar size={14} strokeWidth={1.5} />
                {format(parseISO(live.date), 'EEEE, MMM d')}
              </button>
            )}
            {editingTime ? (
              <span
                className="modal-meta-item"
                onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setEditingTime(false); }}
              >
                <Clock size={14} strokeWidth={1.5} />
                <input
                  type="time"
                  className="modal-meta-input"
                  autoFocus
                  defaultValue={toInputTime(live.startTime)}
                  onBlur={e => commitStartTime(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.stopPropagation(); setEditingTime(false); }
                  }}
                />
                <span>–</span>
                <input
                  type="time"
                  className="modal-meta-input"
                  defaultValue={toInputTime(live.endTime)}
                  onBlur={e => commitEndTime(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.stopPropagation(); setEditingTime(false); }
                  }}
                />
              </span>
            ) : (
              <button
                className="modal-meta-item modal-meta-item--edit"
                onClick={() => setEditingTime(true)}
                title="Change time"
              >
                <Clock size={14} strokeWidth={1.5} />
                {live.startTime ? formatEventTime(live.startTime, live.endTime) : 'Add time'}
              </button>
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

          <div className="modal-completion">
            <button
              className="modal-completion__btn modal-completion__btn--start"
              style={{ borderColor: color.solid }}
              onClick={() => dispatch({ type: 'START_TRACKING', payload: event })}
            >
              <Play size={15} strokeWidth={2} />
              {isCompleted ? 'View Workout' : 'Start Workout'}
            </button>
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
