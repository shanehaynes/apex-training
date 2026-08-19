import { useState } from 'react';
import { Plus, Repeat2, X } from 'lucide-react';
import type { ExerciseCategory, ExerciseDefinition, PlannedSet } from '../../types/workout';
import type { TrackedExercise, TrackedSet, CardioActuals, LastSetActuals } from '../../lib/tracking/plan';
import { resolvePlannedSets } from '../../lib/tracking/plan';
import { countSpecNote, hasPerSideCount, stripCountSpec } from '../../lib/schedule/definitions';
import { useSchedule } from '../../context/ScheduleContext';
import ExercisePicker from '../modal/ExercisePicker';
import DurationInput from './DurationInput';

export type SetField = 'actualWeight' | 'actualReps' | 'actualDuration';
export type CardioField = keyof Omit<CardioActuals, 'isLogged' | 'shadow'>;

interface Props {
  tracked: TrackedExercise;
  accentColor: string;
  onSetChange: (setNumber: number, field: SetField, value: string) => void;
  onCardioChange: (field: CardioField, value: string) => void;
  /** First focus in a shadow row — commit the rendered ghost values into the actuals. */
  onCommitSetShadow: (setNumber: number, values: Partial<Record<SetField, string>>) => void;
  onCommitCardioShadow: (field: CardioField) => void;
  onAddSet: () => void;
  onRemoveSet: (setNumber: number) => void;
  /** Re-point this exercise's logs at another movement, for this day only. */
  onSwap: (def: ExerciseDefinition) => void;
}

// A swap has to keep the logged shape: cardio logs one structured row, every
// other category logs per-set rows. Module-level so the picker's memo holds.
const SET_TRACKED_CATEGORIES: ExerciseCategory[] = ['strength', 'stretch', 'mobility', 'skill'];
const CARDIO_CATEGORIES: ExerciseCategory[] = ['cardio'];

// Side conventions are shown once with the notes, not repeated on every set.
function plannedLabel(p: PlannedSet): string {
  const parts: string[] = [];
  if (p.targetWeight) parts.push(p.targetWeight);
  const reps = stripCountSpec(p.targetReps);
  if (reps) parts.push(`× ${reps}`);
  const duration = stripCountSpec(p.targetDuration);
  if (duration) parts.push(duration);
  return parts.length ? parts.join(' ') : '—';
}

const FIELD_ORDER: SetField[] = ['actualWeight', 'actualReps', 'actualDuration'];

/**
 * Which actual inputs an exercise gets: the union of its planned targets, of
 * whatever already carries a value, and — once swapped — of what the
 * replacement movement is normally logged in. Reps is the fallback so every
 * set has something to log.
 *
 * The already-has-a-value rule keeps logged data reachable no matter which
 * plan it was entered against; without it a swap onto a loaded movement
 * (ring dips → single-arm DB press) would have nowhere to put the weight,
 * since the dips it replaced never prescribed one.
 */
function inputFields(tracked: TrackedExercise, swappedTo?: ExerciseDefinition): SetField[] {
  // A pitch logs exactly one thing: the grade (stored in the weight column —
  // see resolvePlannedSets).
  if (tracked.exercise.category === 'climbing') return ['actualWeight'];

  const fields = new Set<SetField>();
  const planned = resolvePlannedSets(tracked.exercise);
  if (planned.some(p => p.targetWeight)) fields.add('actualWeight');
  if (planned.some(p => p.targetReps)) fields.add('actualReps');
  if (planned.some(p => p.targetDuration)) fields.add('actualDuration');

  for (const set of tracked.sets) {
    for (const field of FIELD_ORDER) if (set[field]) fields.add(field);
  }

  if (tracked.substitutedFrom) {
    if (swappedTo?.defaultDuration) fields.add('actualDuration');
    if (swappedTo?.defaultWeight || swappedTo?.category === 'strength' || !swappedTo) fields.add('actualWeight');
    if (swappedTo?.defaultReps || swappedTo?.category === 'strength' || !swappedTo) fields.add('actualReps');
  }

  if (!fields.size) fields.add('actualReps');
  return FIELD_ORDER.filter(f => fields.has(f));
}

const FIELD_LABEL: Record<SetField, string> = {
  actualWeight: 'weight',
  actualReps: 'reps',
  actualDuration: 'time',
};

const FIELD_CLASS: Record<SetField, string> = {
  actualWeight: 'tracker-input--weight',
  actualReps: 'tracker-input--reps',
  actualDuration: 'tracker-input--time',
};

const SHADOW_FIELD: Record<SetField, keyof LastSetActuals> = {
  actualWeight: 'weight',
  actualReps: 'reps',
  actualDuration: 'duration',
};

function SetRow({
  set,
  fields,
  labels,
  freeText,
  onChange,
  onCommitShadow,
  onRemove,
}: {
  set: TrackedSet;
  fields: SetField[];
  labels: Record<SetField, string>;
  /** Text keyboard instead of decimal — climbing grades mix digits and letters. */
  freeText?: boolean;
  onChange: (field: SetField, value: string) => void;
  onCommitShadow: () => void;
  onRemove?: () => void;
}) {
  // Commit the whole row's ghost, then select the tapped field so the first
  // keystroke replaces the committed value instead of appending to it.
  const focusShadow = (el: HTMLInputElement) => {
    if (!set.shadow) return;
    onCommitShadow();
    requestAnimationFrame(() => el.select());
  };

  return (
    <div className="tracker-set">
      <span className="tracker-set__num">{set.setNumber}</span>
      <span className="tracker-set__planned">{set.isExtra ? 'extra' : plannedLabel(set.planned)}</span>
      <div className="tracker-set__inputs">
        {fields.map(field => {
          const ghost = set.shadow ? set.shadow[SHADOW_FIELD[field]] : '';
          const className = `tracker-input ${FIELD_CLASS[field]}${ghost ? ' tracker-input--shadow' : ''}`;
          return field === 'actualDuration' ? (
            <DurationInput
              key={field}
              className={className}
              ariaLabel={`Set ${set.setNumber} ${labels[field]}`}
              value={set[field]}
              placeholder={ghost || undefined}
              onFocus={set.shadow ? onCommitShadow : undefined}
              onChange={value => onChange(field, value)}
            />
          ) : (
            <input
              key={field}
              className={className}
              type="text"
              inputMode={freeText ? 'text' : 'decimal'}
              aria-label={`Set ${set.setNumber} ${labels[field]}`}
              value={set[field]}
              placeholder={ghost || undefined}
              onFocus={e => focusShadow(e.currentTarget)}
              onChange={e => onChange(field, e.target.value)}
            />
          );
        })}
      </div>
      {onRemove ? (
        <button className="tracker-set__remove" onClick={onRemove} aria-label={`Remove set ${set.setNumber}`}>
          <X size={14} strokeWidth={1.5} />
        </button>
      ) : (
        <span className="tracker-set__remove tracker-set__remove--spacer" />
      )}
    </div>
  );
}

const CARDIO_FIELDS: { field: CardioField; label: string; placeholder: string; inputMode: 'decimal' | 'numeric' | 'text' }[] = [
  { field: 'durationMinutes', label: 'Duration (min)', placeholder: '45', inputMode: 'decimal' },
  { field: 'distance', label: 'Distance', placeholder: '5 mi', inputMode: 'text' },
  { field: 'elevationGain', label: 'Elevation gain', placeholder: '800 ft', inputMode: 'text' },
  { field: 'avgHeartRate', label: 'Avg heart rate', placeholder: '145', inputMode: 'numeric' },
];

export default function TrackerExercise({
  tracked,
  accentColor,
  onSetChange,
  onCardioChange,
  onCommitSetShadow,
  onCommitCardioShadow,
  onAddSet,
  onRemoveSet,
  onSwap,
}: Props) {
  const { definitions } = useSchedule();
  const [picking, setPicking] = useState(false);

  const { exercise, substitutedFrom } = tracked;
  const isClimb = exercise.category === 'climbing';
  const swappedTo = substitutedFrom && exercise.definitionId ? definitions.get(exercise.definitionId) : undefined;
  const fields = inputFields(tracked, swappedTo);
  const labels: Record<SetField, string> = isClimb ? { ...FIELD_LABEL, actualWeight: 'grade' } : FIELD_LABEL;
  const specNote = isClimb ? undefined : countSpecNote(exercise);

  // Only after a swap: the reps were entered against the movement this one
  // replaced, so a bilateral count carried onto a unilateral movement is
  // genuinely ambiguous. On a planned unilateral entry the prescription
  // already states the convention, and repeating it here would just nag.
  const needsPerSideCount = !!swappedTo?.isUnilateral
    && tracked.sets.some(s => s.actualReps && !hasPerSideCount(s.actualReps));

  return (
    <div className="tracker-exercise">
      <div className="tracker-exercise__header">
        <span className="tracker-exercise__name">{exercise.name}</span>
        {!isClimb && (
          <button
            className="tracker-exercise__swap"
            onClick={() => setPicking(true)}
            aria-label={`Swap ${exercise.name} for a different exercise`}
            title="Log this as a different exercise"
          >
            <Repeat2 size={14} strokeWidth={1.5} />
          </button>
        )}
        {exercise.restPeriod && (
          <span className="tracker-exercise__rest" style={{ color: accentColor }}>
            Rest {exercise.restPeriod}
          </span>
        )}
      </div>
      {substitutedFrom && (
        <p className="tracker-exercise__swapped">
          Logged instead of {substitutedFrom} — this day only, the plan is unchanged.
        </p>
      )}
      {needsPerSideCount && (
        <p className="tracker-exercise__notes tracker-exercise__notes--warn">
          {exercise.name} is unilateral — reps are counted per side, so check they read
          that way (e.g. "8 each arm").
        </p>
      )}
      {specNote && <p className="tracker-exercise__notes">{specNote}</p>}
      {exercise.techniqueNotes && <p className="tracker-exercise__notes">{exercise.techniqueNotes}</p>}
      {exercise.notes && exercise.notes !== exercise.techniqueNotes && (
        <p className="tracker-exercise__notes">{exercise.notes}</p>
      )}

      {tracked.isCardio && tracked.cardio ? (
        <div className="tracker-cardio">
          {CARDIO_FIELDS.map(({ field, label, placeholder, inputMode }) => {
            const ghost = tracked.cardio!.shadow?.[field] ?? '';
            return (
              <label key={field} className="tracker-cardio__field">
                <span className="tracker-cardio__label">{label}</span>
                <input
                  className={`tracker-input${ghost ? ' tracker-input--shadow' : ''}`}
                  type="text"
                  inputMode={inputMode}
                  placeholder={ghost || placeholder}
                  value={tracked.cardio![field]}
                  onFocus={e => {
                    if (!ghost) return;
                    onCommitCardioShadow(field);
                    const el = e.currentTarget;
                    requestAnimationFrame(() => el.select());
                  }}
                  onChange={e => onCardioChange(field, e.target.value)}
                />
              </label>
            );
          })}
        </div>
      ) : (
        <>
          <div className="tracker-set tracker-set--head" aria-hidden="true">
            <span className="tracker-set__num">#</span>
            <span className="tracker-set__planned">target</span>
            <div className="tracker-set__inputs">
              {fields.map(field => (
                <span key={field} className={`tracker-input-label ${FIELD_CLASS[field]}`}>
                  {labels[field]}
                </span>
              ))}
            </div>
            <span className="tracker-set__remove tracker-set__remove--spacer" />
          </div>
          {tracked.sets.map(set => (
            <SetRow
              key={set.setNumber}
              set={set}
              fields={fields}
              labels={labels}
              freeText={isClimb}
              onChange={(field, value) => onSetChange(set.setNumber, field, value)}
              onCommitShadow={() => {
                if (!set.shadow) return;
                const values: Partial<Record<SetField, string>> = {};
                for (const field of fields) values[field] = set.shadow[SHADOW_FIELD[field]];
                onCommitSetShadow(set.setNumber, values);
              }}
              onRemove={set.isExtra ? () => onRemoveSet(set.setNumber) : undefined}
            />
          ))}
          <button className="tracker-add-set" onClick={onAddSet}>
            <Plus size={13} strokeWidth={1.5} /> Add set
          </button>
        </>
      )}

      {picking && (
        <ExercisePicker
          onSelect={def => { setPicking(false); onSwap(def); }}
          onClose={() => setPicking(false)}
          restrictTo={tracked.isCardio ? CARDIO_CATEGORIES : SET_TRACKED_CATEGORIES}
        />
      )}
    </div>
  );
}
