import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, X, Dumbbell, Mountain, MountainSnow, HeartPulse, Flower2, Sunrise, StretchHorizontal } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import { toDisplayTime } from '../../lib/time';
import { now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { ExerciseSectionsEditor, validateUnilateral, type SectionLists } from '../modal/EventExerciseEditor';
import { eventPitches, maxGradeOf } from '../../lib/climbing';
import type { CreateEventInput } from '../../lib/schedule/types';
import type { ExerciseCategory, WorkoutType } from '../../types/workout';

const TYPE_ORDER: WorkoutType[] = ['weights', 'climbing', 'outdoor-climbing', 'cardio', 'yoga', 'stretching', 'morning-routine'];

const TYPE_ICONS: Record<WorkoutType, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  'weights': Dumbbell,
  'climbing': Mountain,
  'outdoor-climbing': MountainSnow,
  'cardio': HeartPulse,
  'yoga': Flower2,
  'stretching': StretchHorizontal,
  'morning-routine': Sunrise,
};

/** Library category the picker pre-filters to for each workout type. */
const TYPE_CATEGORY: Record<WorkoutType, ExerciseCategory> = {
  'weights': 'strength',
  'climbing': 'skill',
  'outdoor-climbing': 'climbing',
  'cardio': 'cardio',
  'yoga': 'mobility',
  'stretching': 'stretch',
  'morning-routine': 'mobility',
};

const TYPE_DURATION: Record<WorkoutType, number> = {
  'weights': 60,
  'climbing': 90,
  'outdoor-climbing': 240,
  'cardio': 45,
  'yoga': 45,
  'stretching': 20,
  'morning-routine': 30,
};

const DIFFICULTY_LABELS = ['', 'Easy', 'Moderate', 'Challenging', 'Hard', 'Maximal'];

const EMPTY_LISTS: SectionLists = { warmup: [], exercises: [], cooldown: [] };

/**
 * Full-screen add-event flow (same overlay pattern as the library/tracker):
 * phase 1 picks the workout type, phase 2 fills details and attaches
 * exercises, with the picker biased toward the type's aligned category.
 */
export default function AddEventView() {
  const { state, dispatch } = useCalendar();
  const { definitions, createEvent } = useSchedule();
  const close = () => dispatch({ type: 'CLOSE_COMPOSER' });

  const [type, setType] = useState<WorkoutType | null>(null);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(state.composerDate ?? format(now(), 'yyyy-MM-dd'));
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  // String, not number: parseInt-on-change can't represent an empty field,
  // which made the input impossible to clear. Parsed and validated on save.
  const [duration, setDuration] = useState('60');
  const [distance, setDistance] = useState('');
  const [elevationGain, setElevationGain] = useState('');
  const [avgHeartRate, setAvgHeartRate] = useState('');
  const [maxGrade, setMaxGrade] = useState('');
  const [totalPitches, setTotalPitches] = useState('');
  const [difficulty, setDifficulty] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [tags, setTags] = useState('');
  const [lists, setLists] = useState<SectionLists>(EMPTY_LISTS);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

  const pickType = (t: WorkoutType) => {
    setType(t);
    // Only overwrite fields the user hasn't customized away from the previous type.
    if (!title || TYPE_ORDER.some(o => title === WORKOUT_COLORS[o].label)) setTitle(WORKOUT_COLORS[t].label);
    setDuration(String(TYPE_DURATION[t]));
  };

  const save = async () => {
    if (!type) return;
    if (!title.trim()) { notify('Give the workout a title'); return; }
    const durationMin = parseInt(duration, 10);
    if (!Number.isFinite(durationMin) || durationMin <= 0) { notify('Duration must be a positive number of minutes'); return; }

    const violations = validateUnilateral(lists, definitions);
    setErrors(violations);
    if (violations.size > 0) return;

    const input: CreateEventInput = {
      type,
      title: title.trim(),
      date,
      estimatedDuration: durationMin,
      difficulty,
      startTime: startTime ? toDisplayTime(startTime) ?? undefined : undefined,
      endTime: endTime ? toDisplayTime(endTime) ?? undefined : undefined,
      description: description.trim() || undefined,
      location: location.trim() || undefined,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      exercises: lists.exercises,
      warmup: lists.warmup.length ? lists.warmup : undefined,
      cooldown: lists.cooldown.length ? lists.cooldown : undefined,
    };

    if (type === 'cardio') {
      const hr = parseInt(avgHeartRate, 10);
      const targets = {
        distance: distance.trim() || undefined,
        elevationGain: elevationGain.trim() || undefined,
        avgHeartRate: Number.isFinite(hr) && hr > 0 ? hr : undefined,
      };
      if (Object.values(targets).some(v => v !== undefined)) input.cardioTargets = targets;
    }

    if (type === 'outdoor-climbing') {
      // Only explicitly entered targets persist — blank fields stay derived
      // from the pitch list wherever the event is displayed.
      const pitches = parseInt(totalPitches, 10);
      const targets = {
        maxGrade: maxGrade.trim() || undefined,
        totalPitches: Number.isFinite(pitches) && pitches > 0 ? pitches : undefined,
      };
      if (Object.values(targets).some(v => v !== undefined)) input.climbingTargets = targets;
    }

    setSaving(true);
    const result = await createEvent(input);
    setSaving(false);
    if (result) {
      notify('Workout added');
      close();
    } else {
      notify('Failed to save — try again');
    }
  };

  const color = type ? WORKOUT_COLORS[type] : null;

  // Live auto-derived climbing targets — shown as placeholders so the fields
  // read as prefilled but stay derived unless the user types over them.
  const pitches = eventPitches(lists.exercises);
  const derivedMaxGrade = maxGradeOf(pitches.map(p => p.grade));
  const derivedPitchCount = pitches.length;

  return createPortal(
    <div className="composer-view">
      <header className="library-header">
        <div className="library-header__titles">
          {type && (
            <button className="library-back" onClick={() => setType(null)} aria-label="Back to type selection">
              <ArrowLeft size={16} strokeWidth={1.5} />
            </button>
          )}
          <h1 className="library-header__title">
            {type ? `New ${color!.label} Workout` : 'Add Event'}
          </h1>
          <span className="library-header__count">{format(parseISO(date), 'EEEE, MMM d')}</span>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      {!type ? (
        <div className="composer-type-phase">
          <p className="composer-prompt">What kind of session is this?</p>
          <div className="composer-type-grid">
            {TYPE_ORDER.map(t => {
              const c = WORKOUT_COLORS[t];
              const Icon = TYPE_ICONS[t];
              return (
                <button
                  key={t}
                  className="composer-type-card"
                  style={{ background: c.light, borderColor: c.border }}
                  onClick={() => pickType(t)}
                >
                  <span className="composer-type-card__icon" style={{ color: c.border }}>
                    <Icon size={26} strokeWidth={1.5} />
                  </span>
                  <span className="composer-type-card__label">{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="composer-form">
          <div className="composer-fields">
            <label className="library-field composer-field--wide">
              <span className="library-field__label">Title</span>
              <input className="library-field__input" value={title} onChange={e => setTitle(e.target.value)} />
            </label>
            <label className="library-field">
              <span className="library-field__label">Date</span>
              <input type="date" className="library-field__input" value={date} onChange={e => setDate(e.target.value)} />
            </label>
            <label className="library-field">
              <span className="library-field__label">Duration (min)</span>
              <input
                type="number"
                min={5}
                className="library-field__input"
                value={duration}
                onChange={e => setDuration(e.target.value)}
              />
            </label>
            <label className="library-field">
              <span className="library-field__label">Start time <em>optional</em></span>
              <input type="time" className="library-field__input" value={startTime} onChange={e => setStartTime(e.target.value)} />
            </label>
            <label className="library-field">
              <span className="library-field__label">End time <em>optional</em></span>
              <input type="time" className="library-field__input" value={endTime} onChange={e => setEndTime(e.target.value)} />
            </label>
            {type === 'outdoor-climbing' && (
              <>
                <label className="library-field">
                  <span className="library-field__label">Max grade <em>auto from pitches</em></span>
                  <input
                    className="library-field__input"
                    placeholder={derivedMaxGrade ?? 'e.g. 5.11a'}
                    value={maxGrade}
                    onChange={e => setMaxGrade(e.target.value)}
                  />
                </label>
                <label className="library-field">
                  <span className="library-field__label">Total pitches <em>auto from pitches</em></span>
                  <input
                    inputMode="numeric"
                    className="library-field__input"
                    placeholder={String(derivedPitchCount)}
                    value={totalPitches}
                    onChange={e => setTotalPitches(e.target.value)}
                  />
                </label>
              </>
            )}
            {type === 'cardio' && (
              <>
                <label className="library-field">
                  <span className="library-field__label">Mileage <em>e.g. 5 mi</em></span>
                  <input className="library-field__input" value={distance} onChange={e => setDistance(e.target.value)} />
                </label>
                <label className="library-field">
                  <span className="library-field__label">Elevation gain <em>e.g. 800 ft</em></span>
                  <input className="library-field__input" value={elevationGain} onChange={e => setElevationGain(e.target.value)} />
                </label>
                <label className="library-field">
                  <span className="library-field__label">Avg heart rate <em>optional, bpm</em></span>
                  <input
                    inputMode="numeric"
                    className="library-field__input"
                    value={avgHeartRate}
                    onChange={e => setAvgHeartRate(e.target.value)}
                  />
                </label>
              </>
            )}
            <label className="library-field">
              <span className="library-field__label">Location <em>optional</em></span>
              <input className="library-field__input" value={location} onChange={e => setLocation(e.target.value)} />
            </label>
            <label className="library-field">
              <span className="library-field__label">Tags <em>comma-separated</em></span>
              <input className="library-field__input" value={tags} onChange={e => setTags(e.target.value)} />
            </label>
            <label className="library-field composer-field--wide">
              <span className="library-field__label">Description <em>optional</em></span>
              <textarea
                className="library-field__input library-field__input--textarea"
                rows={2}
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </label>
            <div className="library-field">
              <span className="library-field__label">Difficulty</span>
              <div className="modal-difficulty composer-difficulty">
                {([1, 2, 3, 4, 5] as const).map(d => (
                  <button
                    key={d}
                    className="composer-difficulty__dot"
                    aria-label={`Difficulty ${d} — ${DIFFICULTY_LABELS[d]}`}
                    style={{ background: d <= difficulty ? color!.solid : 'var(--border-subtle)' }}
                    onClick={() => setDifficulty(d)}
                  />
                ))}
                <span className="modal-difficulty__label">{DIFFICULTY_LABELS[difficulty]}</span>
              </div>
            </div>
          </div>

          <div className="composer-exercises">
            <ExerciseSectionsEditor
              lists={lists}
              onChange={setLists}
              errors={errors}
              pickerCategory={TYPE_CATEGORY[type]}
              workoutType={type}
            />
          </div>

          <div className="exercise-editor__bar composer-actions">
            <button className="exercise-editor__cancel" onClick={close} disabled={saving}>Cancel</button>
            <button
              className="exercise-editor__save"
              style={{ borderColor: color!.solid }}
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Add to calendar'}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
