import { Plus, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import type { PlannedSet } from '../../types/workout';
import type { TrackedExercise, TrackedSet, CardioActuals, LastPerformance, LastSetActuals } from '../../lib/tracking/plan';
import { resolvePlannedSets } from '../../lib/tracking/plan';
import DurationInput from './DurationInput';

export type SetField = 'actualWeight' | 'actualReps' | 'actualDuration';
export type CardioField = keyof Omit<CardioActuals, 'isLogged'>;

interface Props {
  tracked: TrackedExercise;
  accentColor: string;
  /** Actuals from the most recent prior session for this exercise, if any. */
  last?: LastPerformance;
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

function lastLabel(last: LastSetActuals): string {
  const parts: string[] = [];
  if (last.weight) parts.push(last.weight);
  if (last.reps) parts.push(`× ${last.reps}`);
  if (last.duration) parts.push(last.duration);
  return parts.join(' ');
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

const LAST_FIELD: Record<SetField, keyof LastSetActuals> = {
  actualWeight: 'weight',
  actualReps: 'reps',
  actualDuration: 'duration',
};

function SetRow({
  set,
  fields,
  last,
  showLast,
  lastDate,
  onChange,
  onRemove,
}: {
  set: TrackedSet;
  fields: SetField[];
  last?: LastSetActuals;
  showLast: boolean;
  lastDate?: string;
  onChange: (field: SetField, value: string) => void;
  onRemove?: () => void;
}) {
  const fillFromLast = () => {
    if (!last) return;
    for (const field of fields) {
      const value = last[LAST_FIELD[field]];
      if (value) onChange(field, value);
    }
  };

  return (
    <div className="tracker-set">
      <span className="tracker-set__num">{set.setNumber}</span>
      <span className="tracker-set__planned">{set.isExtra ? 'extra' : plannedLabel(set.planned)}</span>
      {showLast && (last ? (
        <button
          type="button"
          className="tracker-set__last"
          title={lastDate ? `Last logged ${lastDate} — tap to fill` : 'Tap to fill'}
          onClick={fillFromLast}
        >
          {lastLabel(last)}
        </button>
      ) : (
        <span className="tracker-set__last tracker-set__last--empty">—</span>
      ))}
      <div className="tracker-set__inputs">
        {fields.map(field => field === 'actualDuration' ? (
          <DurationInput
            key={field}
            className={`tracker-input ${FIELD_CLASS[field]}`}
            ariaLabel={`Set ${set.setNumber} ${FIELD_LABEL[field]}`}
            value={set[field]}
            onChange={value => onChange(field, value)}
          />
        ) : (
          <input
            key={field}
            className={`tracker-input ${FIELD_CLASS[field]}`}
            type="text"
            inputMode="decimal"
            aria-label={`Set ${set.setNumber} ${FIELD_LABEL[field]}`}
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
  last,
  onSetChange,
  onCardioChange,
  onAddSet,
  onRemoveSet,
}: Props) {
  const { exercise } = tracked;
  const fields = inputFields(tracked);
  const showLast = !!last;
  const lastDate = last ? format(parseISO(last.date), 'MMM d') : undefined;

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
      {exercise.techniqueNotes && <p className="tracker-exercise__notes">{exercise.techniqueNotes}</p>}
      {exercise.notes && exercise.notes !== exercise.techniqueNotes && (
        <p className="tracker-exercise__notes">{exercise.notes}</p>
      )}

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
          <div className="tracker-set tracker-set--head" aria-hidden="true">
            <span className="tracker-set__num">#</span>
            <span className="tracker-set__planned">target</span>
            {showLast && <span className="tracker-set__last">prev</span>}
            <div className="tracker-set__inputs">
              {fields.map(field => (
                <span key={field} className={`tracker-input-label ${FIELD_CLASS[field]}`}>
                  {FIELD_LABEL[field]}
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
              last={last?.sets.get(set.setNumber)}
              showLast={showLast}
              lastDate={lastDate}
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
