import { useMemo, useState } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { GripVertical, Plus, X } from 'lucide-react';
import { useSchedule } from '../../context/ScheduleContext';
import { baseIdOf, isOccurrenceId } from '../../lib/schedule/occurrence';
import { entryFromDefinition, hasPerSideCount, uniqueEntryId } from '../../lib/schedule/definitions';
import { notify } from '../../lib/notify';
import { CLIMB_STYLES, climbStyleLabel, sectionLabels } from '../../lib/climbing';
import ExercisePicker from './ExercisePicker';
import type { ClimbStyle, Exercise, ExerciseCategory, ExerciseDefinition, WorkoutEvent, WorkoutType } from '../../types/workout';

export type SectionKey = 'warmup' | 'exercises' | 'cooldown';
export type SectionLists = Record<SectionKey, Exercise[]>;

const SECTION_KEYS: SectionKey[] = ['warmup', 'exercises', 'cooldown'];

const PRESCRIPTION_FIELDS = ['sets', 'reps', 'duration', 'weight', 'restPeriod'] as const;

interface Props {
  event: WorkoutEvent;
  accentColor: string;
  onDone: () => void;
}

function EditorCard({
  entry, error, onChange, onRemove,
}: {
  entry: Exercise;
  error?: string;
  onChange: (patch: Partial<Exercise>) => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={entry}
      dragListener={false}
      dragControls={controls}
      className="editor-card"
    >
      <div className="editor-card__header">
        <button
          className="editor-card__grip"
          onPointerDown={e => { e.preventDefault(); controls.start(e); }}
          aria-label="Drag to reorder"
        >
          <GripVertical size={14} strokeWidth={1.5} />
        </button>
        <span className="editor-card__name">{entry.name}</span>
        {entry.plannedSets?.length ? (
          <span className="editor-card__ramp-hint">custom per-set targets — editing clears them</span>
        ) : null}
        <button className="editor-card__remove" onClick={onRemove} aria-label={`Remove ${entry.name}`}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      {entry.category === 'climbing' ? (
        <div className="editor-card__prescription">
          <label className="editor-field">
            <span>Style</span>
            <select
              value={entry.climbStyle ?? 'sport'}
              onChange={e => {
                const style = e.target.value as ClimbStyle;
                onChange({ climbStyle: style, name: climbStyleLabel(style) });
              }}
            >
              {CLIMB_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="editor-field">
            <span>Grade</span>
            <input
              value={entry.grade ?? ''}
              placeholder="5.11a / V5 / WI4"
              onChange={e => onChange({ grade: e.target.value || undefined })}
            />
          </label>
        </div>
      ) : (
      <div className="editor-card__prescription">
        <label className="editor-field">
          <span>Sets</span>
          <input
            inputMode="numeric"
            value={entry.sets ?? ''}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              onChange({ sets: Number.isFinite(n) ? n : undefined });
            }}
          />
        </label>
        <label className="editor-field">
          <span>Reps</span>
          <input value={entry.reps ?? ''} onChange={e => onChange({ reps: e.target.value || undefined })} />
        </label>
        <label className="editor-field">
          <span>Duration</span>
          <input value={entry.duration ?? ''} onChange={e => onChange({ duration: e.target.value || undefined })} />
        </label>
        <label className="editor-field">
          <span>Weight</span>
          <input value={entry.weight ?? ''} onChange={e => onChange({ weight: e.target.value || undefined })} />
        </label>
        <label className="editor-field">
          <span>Rest</span>
          <input value={entry.restPeriod ?? ''} onChange={e => onChange({ restPeriod: e.target.value || undefined })} />
        </label>
      </div>
      )}
      {error && <p className="editor-card__error">{error}</p>}
    </Reorder.Item>
  );
}

/**
 * Same rule the coach executor enforces: unilateral movements state their
 * counts per side. Checked entry-by-entry so the error lands on the card.
 */
export function validateUnilateral(
  lists: SectionLists,
  definitions: Map<string, ExerciseDefinition>,
): Map<string, string> {
  const violations = new Map<string, string>();
  for (const entries of Object.values(lists)) {
    for (const entry of entries) {
      const def = entry.definitionId ? definitions.get(entry.definitionId) : undefined;
      const counted = entry.reps ?? entry.duration;
      if (def?.isUnilateral && counted && !hasPerSideCount(counted)) {
        violations.set(entry.id, `Per-side count needed — e.g. "${counted} each side" (or "total").`);
      }
    }
  }
  return violations;
}

interface SectionsProps {
  lists: SectionLists;
  onChange: (lists: SectionLists) => void;
  errors: Map<string, string>;
  /** Pre-selects the library picker's category filter (clearable to all). */
  pickerCategory?: ExerciseCategory;
  /** Drives section labels and outdoor-climbing behavior (pitches, cardio approach/descent). */
  workoutType?: WorkoutType;
}

/**
 * Controlled three-section (warm-up / main / cool-down) exercise editor: add
 * via the library picker, remove, drag to reorder, edit prescriptions inline.
 * State lives in the caller — used against a saved event by the default
 * export below and against a draft by the add-event composer. Entry ids never
 * change — logged sets key on them (see uniqueEntryId).
 *
 * Outdoor climbing repurposes the sections: warm-up becomes the Approach and
 * cool-down the Descent (both picked from cardio), and main work is a pitch
 * list — one climbing entry per pitch, added directly instead of via the
 * library picker.
 */
export function ExerciseSectionsEditor({ lists, onChange, errors, pickerCategory, workoutType }: SectionsProps) {
  const [pickerSection, setPickerSection] = useState<SectionKey | null>(null);

  const outdoor = workoutType === 'outdoor-climbing';
  const labels = sectionLabels(workoutType);
  const sections = SECTION_KEYS.map(key => ({
    key,
    label: labels[key],
    pickerCategory: outdoor && key !== 'exercises' ? 'cardio' as const : pickerCategory,
    pitchMode: outdoor && key === 'exercises',
  }));

  const allIds = useMemo(
    () => Object.values(lists).flat().map(e => e.id),
    [lists],
  );

  const setSection = (key: SectionKey, entries: Exercise[]) =>
    onChange({ ...lists, [key]: entries });

  const addPitch = (key: SectionKey) => {
    // New pitches inherit the previous pitch's style — multi-pitch days
    // rarely switch disciplines between pitches.
    const style: ClimbStyle = lists[key].filter(e => e.category === 'climbing').at(-1)?.climbStyle ?? 'sport';
    const entry: Exercise = {
      id: uniqueEntryId('pitch', allIds),
      name: climbStyleLabel(style),
      category: 'climbing',
      climbStyle: style,
    };
    setSection(key, [...lists[key], entry]);
  };

  const updateEntry = (key: SectionKey, id: string, patch: Partial<Exercise>) => {
    setSection(key, lists[key].map(e => {
      if (e.id !== id) return e;
      const touchesPrescription = PRESCRIPTION_FIELDS.some(f => f in patch);
      return { ...e, ...patch, ...(touchesPrescription && e.plannedSets ? { plannedSets: undefined } : {}) };
    }));
  };

  const addFromDefinition = (def: ExerciseDefinition) => {
    if (!pickerSection) return;
    const entry = entryFromDefinition(def, uniqueEntryId(def.id, allIds));
    setSection(pickerSection, [...lists[pickerSection], entry]);
    setPickerSection(null);
  };

  return (
    <>
      {sections.map(({ key, label, pitchMode }) => (
        <div key={key} className="modal-section">
          <div className="modal-section__header">
            <span className="modal-section__line" />
            <span className="modal-section__label">{label}</span>
            <span className="modal-section__line" />
          </div>
          <Reorder.Group
            axis="y"
            values={lists[key]}
            onReorder={entries => setSection(key, entries)}
            className="exercise-editor__list"
          >
            {lists[key].map(entry => (
              <EditorCard
                key={entry.id}
                entry={entry}
                error={errors.get(entry.id)}
                onChange={patch => updateEntry(key, entry.id, patch)}
                onRemove={() => setSection(key, lists[key].filter(e => e.id !== entry.id))}
              />
            ))}
          </Reorder.Group>
          {pitchMode ? (
            <button className="exercise-editor__add" onClick={() => addPitch(key)}>
              <Plus size={14} strokeWidth={1.5} /> Add pitch
            </button>
          ) : (
            <button className="exercise-editor__add" onClick={() => setPickerSection(key)}>
              <Plus size={14} strokeWidth={1.5} /> Add exercise
            </button>
          )}
        </div>
      ))}

      {pickerSection && (
        <ExercisePicker
          onSelect={addFromDefinition}
          onClose={() => setPickerSection(null)}
          initialCategory={sections.find(s => s.key === pickerSection)?.pickerCategory}
        />
      )}
    </>
  );
}

/**
 * Edit mode for the modal's exercise sections. Edits batch locally and
 * commit as one updateEvent on Save.
 */
export default function EventExerciseEditor({ event, accentColor, onDone }: Props) {
  const { definitions, updateEvent } = useSchedule();
  const [lists, setLists] = useState<SectionLists>({
    warmup: event.warmup ?? [],
    exercises: event.exercises,
    cooldown: event.cooldown ?? [],
  });
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);

  const seriesWide = event.isRecurring || isOccurrenceId(event.id);

  const save = async () => {
    const violations = validateUnilateral(lists, definitions);
    setErrors(violations);
    if (violations.size > 0) return;

    const fields: Partial<WorkoutEvent> = {};
    if (JSON.stringify(lists.warmup) !== JSON.stringify(event.warmup ?? [])) fields.warmup = lists.warmup;
    if (JSON.stringify(lists.exercises) !== JSON.stringify(event.exercises)) fields.exercises = lists.exercises;
    if (JSON.stringify(lists.cooldown) !== JSON.stringify(event.cooldown ?? [])) fields.cooldown = lists.cooldown;
    if (Object.keys(fields).length === 0) { onDone(); return; }

    setSaving(true);
    const ok = await updateEvent({ id: baseIdOf(event.id), fields, triggeredBy: 'user' });
    setSaving(false);
    if (ok) {
      notify('Exercises updated');
      onDone();
    } else {
      notify('Failed to save — try again');
    }
  };

  return (
    <div className="exercise-editor">
      {seriesWide && (
        <p className="exercise-editor__series-note">
          This is a recurring workout — changes apply to every occurrence of the series.
        </p>
      )}

      <ExerciseSectionsEditor lists={lists} onChange={setLists} errors={errors} workoutType={event.type} />

      <div className="exercise-editor__bar">
        <button className="exercise-editor__cancel" onClick={onDone} disabled={saving}>Cancel</button>
        <button
          className="exercise-editor__save"
          style={{ borderColor: accentColor }}
          onClick={save}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save exercises'}
        </button>
      </div>
    </div>
  );
}
