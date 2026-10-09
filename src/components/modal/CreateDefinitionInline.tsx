import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSchedule } from '../../context/schedule';
import { hasPerSideCount } from '../../lib/schedule/definitions';
import type { ExerciseCategory, ExerciseDefinition } from '../../types/workout';

interface Props {
  /** The trimmed query — what the new definition is called. */
  name: string;
  categories: ExerciseCategory[];
  initialCategory: ExerciseCategory;
  /** Matches or near matches are on screen above: the create is the override. */
  anyway: boolean;
  confirmLabel: string;
  onCreated: (def: ExerciseDefinition) => void;
}

/**
 * The library's inline create — a row that opens into category + unilateral
 * — shared by the exercise picker (add, swap) and the Library screen, so a
 * movement is added the same way wherever its name comes up missing.
 */
export default function CreateDefinitionInline({ name, categories, initialCategory, anyway, confirmLabel, onCreated }: Props) {
  const { createDefinition } = useSchedule();
  const [creating, setCreating] = useState(false);
  const [category, setCategory] = useState<ExerciseCategory>(initialCategory);
  const [unilateral, setUnilateral] = useState(false);
  const [busy, setBusy] = useState(false);

  // A changed name is a new question: fold the form back to the row.
  useEffect(() => { setCreating(false); }, [name]);
  // A filter chip changed after the row appeared is the category to start from.
  useEffect(() => { setCategory(initialCategory); }, [initialCategory]);

  const create = async () => {
    setBusy(true);
    const result = await createDefinition({ canonicalName: name, category, isUnilateral: unilateral });
    setBusy(false);
    if (!result) return;
    // Built locally — the context's definitions map updates on its own schedule.
    onCreated({
      id: result.id,
      canonicalName: name,
      aliases: [],
      category,
      muscleGroups: [],
      equipment: [],
      isUnilateral: unilateral || hasPerSideCount(name),
    });
  };

  if (!creating) {
    return (
      <button className="exercise-picker__create-row" onClick={() => setCreating(true)}>
        <Plus size={14} strokeWidth={1.5} /> Create "{name}" as a new exercise{anyway ? ' anyway' : ''}
      </button>
    );
  }

  return (
    <div className="exercise-picker__create-form">
      <span className="exercise-picker__create-name">New exercise: <strong>{name}</strong></span>
      <div className="exercise-picker__create-controls">
        <select
          className="library-field__input"
          value={category}
          onChange={e => setCategory(e.target.value as ExerciseCategory)}
        >
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="library-field--checkbox exercise-picker__unilateral">
          <input type="checkbox" checked={unilateral} onChange={e => setUnilateral(e.target.checked)} />
          <span className="library-field__label">Unilateral</span>
        </label>
        <button className="library-editor__save" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
