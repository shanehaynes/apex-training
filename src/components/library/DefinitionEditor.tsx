import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Archive, ArchiveRestore } from 'lucide-react';
import { useSchedule } from '../../context/ScheduleContext';
import { notify } from '../../lib/notify';
import DurationInput from '../tracker/DurationInput';
import type { ExerciseCategory, ExerciseDefinition } from '../../types/workout';

interface Props {
  definition: ExerciseDefinition;
  referenceCount: number;
  onClose: () => void;
}

const CATEGORIES: ExerciseCategory[] = ['strength', 'stretch', 'mobility', 'skill', 'cardio'];

const splitList = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);

/**
 * Edits library-tier fields only — prescriptions (a workout's actual
 * sets/reps/weight) live on events and are deliberately absent here. The
 * defaults section is insert-time prefill, and says so.
 */
export default function DefinitionEditor({ definition, referenceCount, onClose }: Props) {
  const { updateDefinition } = useSchedule();
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(definition.canonicalName);
  const [category, setCategory] = useState<ExerciseCategory>(definition.category);
  const [muscleGroups, setMuscleGroups] = useState(definition.muscleGroups.join(', '));
  const [equipment, setEquipment] = useState(definition.equipment.join(', '));
  const [techniqueNotes, setTechniqueNotes] = useState(definition.techniqueNotes ?? '');
  const [isUnilateral, setIsUnilateral] = useState(definition.isUnilateral);
  const [defaultSets, setDefaultSets] = useState(definition.defaultSets != null ? String(definition.defaultSets) : '');
  const [defaultReps, setDefaultReps] = useState(definition.defaultReps ?? '');
  const [defaultDuration, setDefaultDuration] = useState(definition.defaultDuration ?? '');
  const [defaultWeight, setDefaultWeight] = useState(definition.defaultWeight ?? '');
  const [defaultRest, setDefaultRest] = useState(definition.defaultRest ?? '');

  const isRename = name.trim() !== definition.canonicalName;

  const changedFields = (): Partial<ExerciseDefinition> => {
    const fields: Partial<ExerciseDefinition> = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== definition.canonicalName) fields.canonicalName = trimmedName;
    if (category !== definition.category) fields.category = category;
    const groups = splitList(muscleGroups);
    if (groups.join('|') !== definition.muscleGroups.join('|')) fields.muscleGroups = groups;
    const equip = splitList(equipment);
    if (equip.join('|') !== definition.equipment.join('|')) fields.equipment = equip;
    if (techniqueNotes.trim() !== (definition.techniqueNotes ?? '')) fields.techniqueNotes = techniqueNotes.trim();
    if (isUnilateral !== definition.isUnilateral) fields.isUnilateral = isUnilateral;
    const sets = defaultSets.trim() === '' ? undefined : Number(defaultSets);
    if (sets !== definition.defaultSets && !(Number.isNaN(sets))) fields.defaultSets = sets;
    if (defaultReps.trim() !== (definition.defaultReps ?? '')) fields.defaultReps = defaultReps.trim();
    if (defaultDuration.trim() !== (definition.defaultDuration ?? '')) fields.defaultDuration = defaultDuration.trim();
    if (defaultWeight.trim() !== (definition.defaultWeight ?? '')) fields.defaultWeight = defaultWeight.trim();
    if (defaultRest.trim() !== (definition.defaultRest ?? '')) fields.defaultRest = defaultRest.trim();
    return fields;
  };

  const save = async () => {
    const fields = changedFields();
    if (Object.keys(fields).length === 0) { onClose(); return; }
    setSaving(true);
    const ok = await updateDefinition({ id: definition.id, fields });
    setSaving(false);
    if (ok) {
      notify(`Updated "${fields.canonicalName ?? definition.canonicalName}"`);
      onClose();
    } else {
      notify('Failed to save — try again');
    }
  };

  const toggleArchive = async () => {
    setSaving(true);
    // Explicit null clears archived_at server-side; undefined would be
    // dropped by the field mapper and make Restore a no-op.
    const ok = await updateDefinition({
      id: definition.id,
      fields: { archivedAt: definition.archivedAt ? null : new Date().toISOString() } as unknown as Partial<ExerciseDefinition>,
    });
    setSaving(false);
    if (ok) {
      notify(definition.archivedAt ? 'Restored to library' : 'Archived — existing workouts keep it');
      onClose();
    } else {
      notify('Failed — try again');
    }
  };

  return createPortal(
    <div className="modal-backdrop modal-backdrop--library-editor" onClick={onClose}>
      <div className="library-editor" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <header className="library-editor__header">
          <div>
            <h2 className="library-editor__title">Edit exercise</h2>
            <p className="library-editor__radius">
              Changes here affect {referenceCount} workout{referenceCount === 1 ? '' : 's'} — everywhere this exercise appears.
            </p>
          </div>
          <button className="library-close" onClick={onClose} aria-label="Close editor">
            <X size={18} strokeWidth={1.5} />
          </button>
        </header>

        <div className="library-editor__body">
          <label className="library-field">
            <span className="library-field__label">Name</span>
            <input className="library-field__input" value={name} onChange={e => setName(e.target.value)} />
            {isRename && (
              <span className="library-field__hint">
                "{definition.canonicalName}" stays attached as an alias — PR history follows the rename.
              </span>
            )}
          </label>

          <div className="library-field-row">
            <label className="library-field">
              <span className="library-field__label">Category</span>
              <select className="library-field__input" value={category} onChange={e => setCategory(e.target.value as ExerciseCategory)}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="library-field library-field--checkbox">
              <input type="checkbox" checked={isUnilateral} onChange={e => setIsUnilateral(e.target.checked)} />
              <span className="library-field__label">Unilateral (counts are per side)</span>
            </label>
          </div>

          <label className="library-field">
            <span className="library-field__label">Muscle groups <em>(comma-separated)</em></span>
            <input className="library-field__input" value={muscleGroups} onChange={e => setMuscleGroups(e.target.value)} placeholder="quads, glutes" />
          </label>

          <label className="library-field">
            <span className="library-field__label">Equipment <em>(comma-separated)</em></span>
            <input className="library-field__input" value={equipment} onChange={e => setEquipment(e.target.value)} placeholder="barbell, rack" />
          </label>

          <label className="library-field">
            <span className="library-field__label">Technique notes</span>
            <textarea
              className="library-field__input library-field__input--textarea"
              rows={4}
              value={techniqueNotes}
              onChange={e => setTechniqueNotes(e.target.value)}
              placeholder="Form cues, setup, safety…"
            />
          </label>

          <div className="library-editor__defaults">
            <h3 className="library-section-heading">Defaults for newly added exercises</h3>
            <p className="library-editor__defaults-note">
              Prefills when this exercise is added to a workout. Existing workouts keep their own sets/reps/weight.
            </p>
            <div className="library-field-row library-field-row--defaults">
              <label className="library-field">
                <span className="library-field__label">Sets</span>
                <input className="library-field__input" inputMode="numeric" value={defaultSets} onChange={e => setDefaultSets(e.target.value)} />
              </label>
              <label className="library-field">
                <span className="library-field__label">Reps</span>
                <input className="library-field__input" value={defaultReps} onChange={e => setDefaultReps(e.target.value)} />
              </label>
              <div className="library-field library-field--duration">
                <span className="library-field__label">Duration</span>
                <DurationInput
                  className="library-field__input"
                  ariaLabel="Default duration"
                  value={defaultDuration}
                  onChange={setDefaultDuration}
                />
              </div>
              <label className="library-field">
                <span className="library-field__label">Weight</span>
                <input className="library-field__input" value={defaultWeight} onChange={e => setDefaultWeight(e.target.value)} />
              </label>
              <label className="library-field">
                <span className="library-field__label">Rest</span>
                <input className="library-field__input" value={defaultRest} onChange={e => setDefaultRest(e.target.value)} />
              </label>
            </div>
          </div>
        </div>

        <footer className="library-editor__footer">
          <button className="library-editor__archive" onClick={toggleArchive} disabled={saving}>
            {definition.archivedAt
              ? <><ArchiveRestore size={13} strokeWidth={1.5} /> Restore</>
              : <><Archive size={13} strokeWidth={1.5} /> Archive</>}
          </button>
          <div className="library-editor__actions">
            <button className="library-editor__cancel" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="library-editor__save" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
