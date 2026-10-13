import { useRef, useState } from 'react';
import { Pencil, Plus, Repeat2, X } from 'lucide-react';
import type { ExerciseCategory, ExerciseDefinition, PlannedSet } from '../../types/workout';
import type { TrackedExercise, TrackedSet, CardioActuals, LastSetActuals } from '../../lib/tracking/plan';
import { FIELD_ORDER, SET_FIELD_TO_LOG_FIELD, inputFields, nextLogFields, type SetField } from '../../lib/tracking/fields';
import { countSpecNote, hasPerSideCount, stripCountSpec } from '../../lib/schedule/definitions';
import { useSchedule } from '../../context/schedule';
import ExercisePicker from '../modal/ExercisePicker';
import DurationInput from './DurationInput';

export type { SetField };
export type CardioField = keyof Omit<CardioActuals, 'isLogged' | 'shadow'>;

interface Props {
  tracked: TrackedExercise;
  accentColor: string;
  onSetChange: (setNumber: number, field: SetField, value: string) => void;
  onCardioChange: (field: CardioField, value: string) => void;
  /** First focus in a shadow row — commit the rendered ghost values into the actuals. */
  onCommitSetShadow: (setNumber: number, values: Partial<Record<SetField, string>>) => void;
  onCommitCardioShadow: (field: CardioField) => void;
  /** A set row's reps or duration went empty → non-empty (blur or Enter), or
   *  its ghost was tapped: the row is done, the rest starts (R2.1, R2.2). */
  onSetCommit?: (setNumber: number) => void;
  onAddSet: () => void;
  onRemoveSet: (setNumber: number) => void;
  /** Re-point this exercise's logs at another movement, for this day only. */
  onSwap: (def: ExerciseDefinition) => void;
  /** This occurrence's note on the exercise — never written to the plan. */
  onNoteChange: (note: string) => void;
  /** Added mid-workout only: take it back out, deleting what it logged. */
  onRemove?: () => void;
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

// Weight alone is not a set done; reps or a duration is (R2.2).
const COMMIT_FIELDS: SetField[] = ['actualReps', 'actualDuration'];

/** The row holds reps or a duration, among the fields it shows. */
function rowFilled(values: Partial<Record<SetField, string>>, fields: SetField[]): boolean {
  return COMMIT_FIELDS.some(field => fields.includes(field) && !!values[field]?.trim());
}

function SetRow({
  set,
  fields,
  labels,
  freeText,
  unplanned,
  onChange,
  onCommitShadow,
  onCommit,
  onRemove,
}: {
  set: TrackedSet;
  /** An added exercise has no plan at all, so no set of it is an "extra". */
  unplanned?: boolean;
  fields: SetField[];
  labels: Record<SetField, string>;
  /** Text keyboard instead of decimal — climbing grades mix digits and letters. */
  freeText?: boolean;
  onChange: (field: SetField, value: string) => void;
  onCommitShadow: () => void;
  /** The row's reps/duration went empty → non-empty between focus and blur. */
  onCommit: () => void;
  onRemove?: () => void;
}) {
  // Commit the whole row's ghost, then select the tapped field so the first
  // keystroke replaces the committed value instead of appending to it.
  const focusShadow = (el: HTMLInputElement) => {
    if (!set.shadow) return;
    onCommitShadow();
    requestAnimationFrame(() => el.select());
  };

  // Whether the row already held reps/duration when a field took focus. A
  // ghost row counts as filled when its ghost would fill those fields: the
  // tap commits it, and that commit is reported by onCommitShadow's caller,
  // not by the blur that follows.
  const filledAtFocus = useRef(false);
  const filled = rowFilled(set, fields);
  const shadowFills = !!set.shadow && rowFilled(
    { actualReps: set.shadow.reps, actualDuration: set.shadow.duration }, fields,
  );

  return (
    <div className="tracker-set">
      <span className="tracker-set__num">{set.setNumber}</span>
      <span className="tracker-set__planned">{unplanned ? '—' : set.isExtra ? 'extra' : plannedLabel(set.planned)}</span>
      <div
        className="tracker-set__inputs"
        // React's focus/blur bubble, so the row sees every field's; the
        // commit is read at blur from the row's state, not the DOM, because
        // DurationInput's display is a digit buffer while it is focused.
        onFocus={() => { filledAtFocus.current = filled || shadowFills; }}
        onBlur={() => { if (!filledAtFocus.current && filled) onCommit(); }}
      >
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
              // Enter is "done", as it is in DurationInput: the blur commits.
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
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
  onSetCommit,
  onAddSet,
  onRemoveSet,
  onSwap,
  onNoteChange,
  onRemove,
}: Props) {
  const { definitions, updateDefinition } = useSchedule();
  const [picking, setPicking] = useState(false);
  // Shown at once; the definition write that makes them stick lands via the
  // realtime refetch, and an ad-hoc entry with no definition keeps them for
  // this sitting only.
  const [addedHere, setAddedHere] = useState<SetField[]>([]);
  // The subtitle is the library definition's technique notes, so it follows
  // the movement into every workout. The draft is null while not editing;
  // savedSubtitle covers the gap until the realtime refetch brings it back.
  const [subtitleDraft, setSubtitleDraft] = useState<string | null>(null);
  const [savedSubtitle, setSavedSubtitle] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  // Log-field writes go out one after another, each carrying every field
  // added so far: built from the definition alone, a second tap before the
  // realtime refetch would send a stale array and drop the first.
  const logFieldWrites = useRef<Promise<unknown>>(Promise.resolve());

  // A swap re-points this entry at another definition without remounting
  // (the key is the plan entry's id), so anything cached against the old
  // movement must not carry over onto — or be written into — the new one.
  const [scopeId, setScopeId] = useState(tracked.exercise.definitionId);
  if (scopeId !== tracked.exercise.definitionId) {
    setScopeId(tracked.exercise.definitionId);
    setAddedHere([]);
    setSubtitleDraft(null);
    setSavedSubtitle(null);
  }

  const { exercise, substitutedFrom } = tracked;
  const isClimb = exercise.category === 'climbing';
  const definition = exercise.definitionId ? definitions.get(exercise.definitionId) : undefined;
  const swappedTo = substitutedFrom || tracked.isAdded ? definition : undefined;
  const fields = inputFields(tracked, definition, addedHere);
  const addable = isClimb ? [] : FIELD_ORDER.filter(f => !fields.includes(f));

  const showNote = noteOpen || !!tracked.sessionNote;
  const noteButton = showNote ? null : (
    <button
      className="tracker-add-set"
      onClick={() => setNoteOpen(true)}
      aria-label={`Add a note on ${exercise.name} for this workout`}
      title="Stays with this workout only"
    >
      <Plus size={13} strokeWidth={1.5} /> note
    </button>
  );

  const subtitle = savedSubtitle ?? definition?.techniqueNotes ?? exercise.techniqueNotes ?? '';
  const commitSubtitle = () => {
    if (subtitleDraft === null || !definition) return;
    const next = subtitleDraft.trim();
    setSubtitleDraft(null);
    if (next === subtitle) return;
    setSavedSubtitle(next);
    void updateDefinition({ id: definition.id, fields: { techniqueNotes: next } }).then(ok => {
      if (!ok) setSavedSubtitle(null);
    });
  };

  const addField = (field: SetField) => {
    setAddedHere(prev => [...prev, field]);
    if (!definition) return;
    const current = definition.logFields ?? [];
    if (current.includes(SET_FIELD_TO_LOG_FIELD[field])) return;
    const next = nextLogFields(current, addedHere, field);
    const { id } = definition;
    logFieldWrites.current = logFieldWrites.current.then(() =>
      updateDefinition({ id, fields: { logFields: next } }));
  };
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
        {exercise.superset && (
          <span className="superset-badge" title={`Superset ${exercise.superset} — alternate sets with its partners`}>
            {exercise.superset}
          </span>
        )}
        {!isClimb && !tracked.isAdded && (
          <button
            className="tracker-exercise__swap"
            onClick={() => setPicking(true)}
            aria-label={`Swap ${exercise.name} for a different exercise`}
            title="Log this as a different exercise"
          >
            <Repeat2 size={14} strokeWidth={1.5} />
          </button>
        )}
        {definition && !subtitle && subtitleDraft === null && (
          <button
            className="tracker-exercise__swap"
            onClick={() => setSubtitleDraft('')}
            aria-label={`Add a subtitle for ${exercise.name}`}
            title="Add a subtitle, shown with this exercise in every workout"
          >
            <Pencil size={13} strokeWidth={1.5} />
          </button>
        )}
        {onRemove && (
          <button
            className="tracker-exercise__swap"
            style={{ marginLeft: 'auto' }}
            onClick={onRemove}
            aria-label={`Remove ${exercise.name} from this workout`}
            title="Remove — deletes what was logged for it today"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
        {exercise.restPeriod && (
          <span className="tracker-exercise__rest" style={{ color: accentColor }}>
            Rest {exercise.restPeriod}
          </span>
        )}
      </div>
      {tracked.isAdded && (
        <p className="tracker-exercise__swapped">Added to this workout — the plan is unchanged.</p>
      )}
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
      {subtitleDraft !== null ? (
        <input
          className="tracker-input"
          style={{ fontFamily: 'inherit', marginBottom: 8 }}
          autoFocus
          maxLength={500}
          aria-label={`Subtitle for ${exercise.name}, shown in every workout`}
          placeholder="e.g. false grip, rings at chest height"
          value={subtitleDraft}
          onChange={e => setSubtitleDraft(e.target.value)}
          onBlur={commitSubtitle}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setSubtitleDraft(null);
          }}
        />
      ) : definition && subtitle ? (
        <button
          type="button"
          className="tracker-exercise__notes"
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
          onClick={() => setSubtitleDraft(subtitle)}
          aria-label={`Edit subtitle for ${exercise.name}`}
          title="Shown with this exercise in every workout"
        >
          {subtitle} <Pencil size={11} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : subtitle ? (
        <p className="tracker-exercise__notes">{subtitle}</p>
      ) : null}
      {exercise.notes && exercise.notes !== subtitle && (
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
          {noteButton && <div style={{ gridColumn: '1 / -1' }}>{noteButton}</div>}
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
              unplanned={tracked.isAdded}
              onChange={(field, value) => onSetChange(set.setNumber, field, value)}
              onCommitShadow={() => {
                if (!set.shadow) return;
                const values: Partial<Record<SetField, string>> = {};
                for (const field of fields) values[field] = set.shadow[SHADOW_FIELD[field]];
                onCommitSetShadow(set.setNumber, values);
                // Tapping the ghost logs the row (R2.1) — when it logs reps or a duration.
                if (rowFilled(values, fields)) onSetCommit?.(set.setNumber);
              }}
              onCommit={() => onSetCommit?.(set.setNumber)}
              onRemove={set.isExtra ? () => onRemoveSet(set.setNumber) : undefined}
            />
          ))}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button className="tracker-add-set" onClick={onAddSet}>
              <Plus size={13} strokeWidth={1.5} /> Add set
            </button>
            {addable.map(field => (
              <button
                key={field}
                className="tracker-add-set"
                onClick={() => addField(field)}
                aria-label={`Track ${FIELD_LABEL[field]} for ${exercise.name}`}
                title={definition
                  ? `Log ${FIELD_LABEL[field]} for ${exercise.name} from now on, in every workout`
                  : `Log ${FIELD_LABEL[field]} for this workout (not in the exercise library)`}
              >
                <Plus size={13} strokeWidth={1.5} /> {FIELD_LABEL[field]}
              </button>
            ))}
            {noteButton}
          </div>
        </>
      )}

      {showNote && (
        <textarea
          className="tracker-input"
          style={{ fontFamily: 'inherit', height: 'auto', padding: '6px 10px', marginTop: 8, resize: 'vertical' }}
          rows={2}
          maxLength={2000}
          autoFocus={noteOpen && !tracked.sessionNote}
          aria-label={`Note on ${exercise.name} for this workout only`}
          placeholder="Today only — e.g. left shoulder pinchy on set 3"
          value={tracked.sessionNote}
          onChange={e => onNoteChange(e.target.value)}
          onBlur={() => { if (!tracked.sessionNote.trim()) setNoteOpen(false); }}
        />
      )}

      {picking && (
        <ExercisePicker
          onSelect={def => { setPicking(false); onSwap(def); }}
          onClose={() => setPicking(false)}
          restrictTo={tracked.isCardio ? CARDIO_CATEGORIES : SET_TRACKED_CATEGORIES}
          createCategory={tracked.exercise.category}
        />
      )}
    </div>
  );
}
