import { Plus, X } from 'lucide-react';
import type { PlannedSet } from '../../types/workout';
import type { TrackedExercise, TrackedSet, CardioActuals } from '../../lib/tracking/plan';
import { resolvePlannedSets } from '../../lib/tracking/plan';

export type SetField = 'actualWeight' | 'actualReps' | 'actualDuration';
export type CardioField = keyof Omit<CardioActuals, 'isLogged'>;

interface Props {
  tracked: TrackedExercise;
  accentColor: string;
  onSetChange: (setNumber: number, field: SetField, value: string) => void;
  onCardioChange: (field: CardioField, value: string) => void;
  onAddSet: () => void;
  onRemoveSet: (setNumber: number) => void;
}

function plannedLabel(p: PlannedSet): string {
  const parts: string[] = [];
  if (p.targetWeight) parts.push(p.targetWeight);
  if (p.targetReps) parts.push(`× ${p.targetReps}`);
  if (p.targetDuration) parts.push(p.targetDuration);
  return parts.length ? parts.join(' ') : '—';
}

// Which actual inputs an exercise gets, derived from the union of its
// planned targets (reps as the fallback so every set has something to log).
function inputFields(tracked: TrackedExercise): SetField[] {
  const planned = resolvePlannedSets(tracked.exercise);
  const fields: SetField[] = [];
  if (planned.some(p => p.targetWeight)) fields.push('actualWeight');
  if (planned.some(p => p.targetReps)) fields.push('actualReps');
  if (planned.some(p => p.targetDuration)) fields.push('actualDuration');
  if (!fields.length) fields.push('actualReps');
  return fields;
}

const FIELD_PLACEHOLDER: Record<SetField, string> = {
  actualWeight: 'weight',
  actualReps: 'reps',
  actualDuration: 'time',
};

function SetRow({
  set,
  fields,
  onChange,
  onRemove,
}: {
  set: TrackedSet;
  fields: SetField[];
  onChange: (field: SetField, value: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="tracker-set">
      <span className="tracker-set__num">{set.setNumber}</span>
      <span className="tracker-set__planned">{set.isExtra ? 'extra' : plannedLabel(set.planned)}</span>
      <div className="tracker-set__inputs">
        {fields.map(field => (
          <input
            key={field}
            className="tracker-input"
            type="text"
            inputMode={field === 'actualDuration' ? 'text' : 'decimal'}
            placeholder={FIELD_PLACEHOLDER[field]}
            aria-label={`Set ${set.setNumber} ${FIELD_PLACEHOLDER[field]}`}
            value={set[field]}
            onChange={e => onChange(field, e.target.value)}
          />
        ))}
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
  onAddSet,
  onRemoveSet,
}: Props) {
  const { exercise } = tracked;

  return (
    <div className="tracker-exercise">
      <div className="tracker-exercise__header">
        <span className="tracker-exercise__name">{exercise.name}</span>
        {exercise.restPeriod && (
          <span className="tracker-exercise__rest" style={{ color: accentColor }}>
            Rest {exercise.restPeriod}
          </span>
        )}
      </div>
      {exercise.notes && <p className="tracker-exercise__notes">{exercise.notes}</p>}

      {tracked.isCardio && tracked.cardio ? (
        <div className="tracker-cardio">
          {CARDIO_FIELDS.map(({ field, label, placeholder, inputMode }) => (
            <label key={field} className="tracker-cardio__field">
              <span className="tracker-cardio__label">{label}</span>
              <input
                className="tracker-input"
                type="text"
                inputMode={inputMode}
                placeholder={placeholder}
                value={tracked.cardio![field]}
                onChange={e => onCardioChange(field, e.target.value)}
              />
            </label>
          ))}
        </div>
      ) : (
        <>
          {tracked.sets.map(set => (
            <SetRow
              key={set.setNumber}
              set={set}
              fields={inputFields(tracked)}
              onChange={(field, value) => onSetChange(set.setNumber, field, value)}
              onRemove={set.isExtra ? () => onRemoveSet(set.setNumber) : undefined}
            />
          ))}
          <button className="tracker-add-set" onClick={onAddSet}>
            <Plus size={13} strokeWidth={1.5} /> Add set
          </button>
        </>
      )}
    </div>
  );
}
