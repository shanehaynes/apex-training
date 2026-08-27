import { useState, type Dispatch, type SetStateAction } from 'react';
import { Dumbbell, Mountain, MountainSnow, HeartPulse, Flower2, Sunrise, StretchHorizontal } from 'lucide-react';
import RepeatPicker from './RepeatPicker';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import { DIFFICULTY_LABELS } from '../../utils/difficulty';
import { eventPitches, maxGradeOf } from '../../lib/climbing';
import { ExerciseSectionsEditor } from '../modal/EventExerciseEditor';
import { TYPE_CATEGORY, TYPE_ORDER, withType, type WorkoutDraft } from '../../lib/builder/draft';
import type { ScoringType, WorkoutType } from '../../types/workout';

const TYPE_ICONS: Record<WorkoutType, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  'weights': Dumbbell,
  'climbing': Mountain,
  'outdoor-climbing': MountainSnow,
  'cardio': HeartPulse,
  'yoga': Flower2,
  'stretching': StretchHorizontal,
  'morning-routine': Sunrise,
};

const SCORING_OPTIONS: Array<{ value: ScoringType; label: string; hint: string }> = [
  { value: 'strength', label: 'Strength', hint: 'PRs per exercise — best weight, reps, or hold.' },
  { value: 'for-time', label: 'For Time', hint: 'Fixed work; the PR is your fastest finish.' },
  { value: 'amrap', label: 'AMRAP', hint: 'Fixed clock; the PR is most rounds + reps.' },
];

interface Props {
  draft: WorkoutDraft;
  setDraft: Dispatch<SetStateAction<WorkoutDraft>>;
  errors: Map<string, string>;
  saving: boolean;
  mode: 'create' | 'edit';
  /** Editing a recurring occurrence: saving asks this-event-only vs series. */
  isRecurringSeries: boolean;
  accentColor: string;
  /** scope arrives only in edit mode on a recurring occurrence. */
  onSubmit: (scope?: 'occurrence' | 'series') => void;
  onCancel: () => void;
}

/** The builder's form step: category, scoring, schedule, and exercises. */
export default function BuilderForm({
  draft, setDraft, errors, saving, mode, isRecurringSeries, accentColor, onSubmit, onCancel,
}: Props) {
  const set = <K extends keyof WorkoutDraft>(key: K, value: WorkoutDraft[K]) =>
    setDraft(prev => ({ ...prev, [key]: value }));

  const [choosingScope, setChoosingScope] = useState(false);
  const asksScope = mode === 'edit' && isRecurringSeries;

  // Live auto-derived climbing targets — placeholders, so the fields read as
  // prefilled but stay derived unless the user types over them.
  const pitches = eventPitches(draft.lists.exercises);
  const derivedMaxGrade = maxGradeOf(pitches.map(p => p.grade));
  const scoringHint = SCORING_OPTIONS.find(o => o.value === draft.scoringType)!.hint;

  return (
    <div className="composer-form builder-form">
      <div className="builder-type-row" role="radiogroup" aria-label="Workout category">
        {TYPE_ORDER.map(t => {
          const c = WORKOUT_COLORS[t];
          const Icon = TYPE_ICONS[t];
          const active = draft.type === t;
          return (
            <button
              key={t}
              role="radio"
              aria-checked={active}
              className={`builder-type-chip${active ? ' builder-type-chip--active' : ''}`}
              style={active ? { borderColor: c.solid, color: c.solid, background: c.light } : undefined}
              onClick={() => setDraft(prev => withType(prev, t))}
            >
              <Icon size={14} strokeWidth={1.5} />
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="builder-scoring">
        <div className="builder-scoring__toggle" role="radiogroup" aria-label="Scoring type">
          {SCORING_OPTIONS.map(o => (
            <button
              key={o.value}
              role="radio"
              aria-checked={draft.scoringType === o.value}
              className={`builder-scoring__btn${draft.scoringType === o.value ? ' builder-scoring__btn--active' : ''}`}
              style={draft.scoringType === o.value ? { borderColor: accentColor, color: accentColor } : undefined}
              onClick={() => set('scoringType', o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="builder-scoring__hint">{scoringHint}</span>
        {draft.scoringType === 'amrap' && (
          <label className="library-field builder-scoring__cap">
            <span className="library-field__label">Time cap (min)</span>
            <input
              inputMode="numeric"
              className="library-field__input"
              value={draft.timeCap}
              onChange={e => set('timeCap', e.target.value)}
            />
          </label>
        )}
      </div>

      <div className="composer-fields">
        <label className="library-field composer-field--wide">
          <span className="library-field__label">Title</span>
          <input className="library-field__input" value={draft.title} onChange={e => set('title', e.target.value)} />
        </label>
        <label className="library-field">
          <span className="library-field__label">
            Date {isRecurringSeries && <em>this event only</em>}
          </span>
          <input
            type="date"
            className="library-field__input"
            value={draft.date}
            onChange={e => set('date', e.target.value)}
          />
        </label>
        <label className="library-field">
          <span className="library-field__label">Duration (min)</span>
          <input
            type="number"
            min={5}
            className="library-field__input"
            value={draft.duration}
            onChange={e => set('duration', e.target.value)}
          />
        </label>
        <label className="library-field">
          <span className="library-field__label">Start time <em>optional</em></span>
          <input
            type="time"
            className="library-field__input"
            value={draft.startTime}
            onChange={e => set('startTime', e.target.value)}
          />
        </label>
        <label className="library-field">
          <span className="library-field__label">End time <em>optional</em></span>
          <input
            type="time"
            className="library-field__input"
            value={draft.endTime}
            onChange={e => set('endTime', e.target.value)}
          />
        </label>
        <RepeatPicker
          repeat={draft.repeat}
          onChange={r => set('repeat', r)}
          lockOff={isRecurringSeries}
          accentColor={accentColor}
        />
        {draft.type === 'outdoor-climbing' && (
          <>
            <label className="library-field">
              <span className="library-field__label">Max grade <em>auto from pitches</em></span>
              <input
                className="library-field__input"
                placeholder={derivedMaxGrade ?? 'e.g. 5.11a'}
                value={draft.maxGrade}
                onChange={e => set('maxGrade', e.target.value)}
              />
            </label>
            <label className="library-field">
              <span className="library-field__label">Total pitches <em>auto from pitches</em></span>
              <input
                inputMode="numeric"
                className="library-field__input"
                placeholder={String(pitches.length)}
                value={draft.totalPitches}
                onChange={e => set('totalPitches', e.target.value)}
              />
            </label>
          </>
        )}
        {draft.type === 'cardio' && (
          <>
            <label className="library-field">
              <span className="library-field__label">Mileage <em>e.g. 5 mi</em></span>
              <input className="library-field__input" value={draft.distance} onChange={e => set('distance', e.target.value)} />
            </label>
            <label className="library-field">
              <span className="library-field__label">Elevation gain <em>e.g. 800 ft</em></span>
              <input className="library-field__input" value={draft.elevationGain} onChange={e => set('elevationGain', e.target.value)} />
            </label>
            <label className="library-field">
              <span className="library-field__label">Avg heart rate <em>optional, bpm</em></span>
              <input
                inputMode="numeric"
                className="library-field__input"
                value={draft.avgHeartRate}
                onChange={e => set('avgHeartRate', e.target.value)}
              />
            </label>
          </>
        )}
        <label className="library-field">
          <span className="library-field__label">Location <em>optional</em></span>
          <input className="library-field__input" value={draft.location} onChange={e => set('location', e.target.value)} />
        </label>
        <label className="library-field">
          <span className="library-field__label">Tags <em>comma-separated</em></span>
          <input className="library-field__input" value={draft.tags} onChange={e => set('tags', e.target.value)} />
        </label>
        <label className="library-field composer-field--wide">
          <span className="library-field__label">Description <em>optional</em></span>
          <textarea
            className="library-field__input library-field__input--textarea"
            rows={2}
            value={draft.description}
            onChange={e => set('description', e.target.value)}
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
                style={{ background: d <= draft.difficulty ? accentColor : 'var(--border-subtle)' }}
                onClick={() => set('difficulty', d)}
              />
            ))}
            <span className="modal-difficulty__label">{DIFFICULTY_LABELS[draft.difficulty]}</span>
          </div>
        </div>
      </div>

      <div className="composer-exercises">
        <ExerciseSectionsEditor
          lists={draft.lists}
          onChange={lists => set('lists', lists)}
          errors={errors}
          pickerCategory={TYPE_CATEGORY[draft.type]}
          workoutType={draft.type}
        />
      </div>

      {mode === 'create' && (
        <p className="builder-apply-note">Apply saves this workout to your library and adds it to the calendar.</p>
      )}

      {choosingScope ? (
        <div className="exercise-editor__bar composer-actions builder-scope">
          <span className="builder-scope__question">
            Apply to this event only — it leaves the series for good, keeping anything logged — or to the whole series?
          </span>
          <button className="exercise-editor__cancel" onClick={() => setChoosingScope(false)} disabled={saving}>
            Back
          </button>
          <button
            className="exercise-editor__save"
            style={{ borderColor: accentColor }}
            onClick={() => onSubmit('occurrence')}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'This event only'}
          </button>
          <button
            className="exercise-editor__save"
            style={{ borderColor: accentColor }}
            onClick={() => onSubmit('series')}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Whole series'}
          </button>
        </div>
      ) : (
        <div className="exercise-editor__bar composer-actions">
          <button className="exercise-editor__cancel" onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            className="exercise-editor__save"
            style={{ borderColor: accentColor }}
            onClick={() => (asksScope ? setChoosingScope(true) : onSubmit())}
            disabled={saving}
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Apply' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
