import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { format, parseISO } from 'date-fns';
import { Plus, Search, X } from 'lucide-react';
import { useSchedule } from '../../context/ScheduleContext';
import { buildAliasIndex, hasPerSideCount, matchDefinitionByName } from '../../lib/schedule/definitions';
import { fetchLastPerformedRows } from '../../lib/library/repo';
import { lastPerformedByCanonical } from '../../lib/library/stats';
import type { ExerciseCategory, ExerciseDefinition } from '../../types/workout';

interface Props {
  onSelect: (def: ExerciseDefinition) => void;
  onClose: () => void;
  /** Pre-selects a category filter aligned with the workout type (clearable). */
  initialCategory?: ExerciseCategory;
}

const CATEGORIES: ExerciseCategory[] = ['strength', 'stretch', 'mobility', 'skill', 'cardio', 'climbing'];

function defaultsPreview(def: ExerciseDefinition): string {
  const parts: string[] = [];
  if (def.defaultSets && def.defaultReps) parts.push(`${def.defaultSets} × ${def.defaultReps}`);
  else if (def.defaultSets) parts.push(`${def.defaultSets} sets`);
  else if (def.defaultReps) parts.push(def.defaultReps);
  if (def.defaultDuration) parts.push(def.defaultDuration);
  if (def.defaultWeight) parts.push(def.defaultWeight);
  if (def.defaultRest) parts.push(`rest ${def.defaultRest}`);
  return parts.join(' · ');
}

/**
 * Search-first add flow over the exercise library: exact-match-or-create,
 * never fuzzy — seeing the near-matches before "Create" is what prevents
 * duplicate library entries.
 */
export default function ExercisePicker({ onSelect, onClose, initialCategory }: Props) {
  const { definitions, createDefinition } = useSchedule();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ExerciseCategory | null>(initialCategory ?? null);
  const [creating, setCreating] = useState(false);
  const [newCategory, setNewCategory] = useState<ExerciseCategory>(initialCategory ?? 'strength');
  const [newUnilateral, setNewUnilateral] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastPerformed, setLastPerformed] = useState<Map<string, string>>(new Map());

  // Capture phase so Escape closes the picker before the modal's document
  // listener can react to the same keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const index = buildAliasIndex(definitions.values());
    fetchLastPerformedRows()
      .then(rows => { if (!cancelled) setLastPerformed(lastPerformedByCanonical(rows, index.toCanonical)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [definitions]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...definitions.values()]
      .filter(def => !def.archivedAt)
      .filter(def => !category || def.category === category)
      .filter(def =>
        !needle ||
        def.canonicalName.toLowerCase().includes(needle) ||
        def.aliases.some(a => a.toLowerCase().includes(needle)) ||
        def.muscleGroups.some(m => m.toLowerCase().includes(needle)))
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  }, [definitions, query, category]);

  const trimmed = query.trim();
  // Offer create only when the query is no existing name/alias — an exact
  // match should be selected, not duplicated.
  const canCreate = trimmed.length > 1 && !matchDefinitionByName(trimmed, definitions.values());

  const createAndSelect = async () => {
    setBusy(true);
    const result = await createDefinition({
      canonicalName: trimmed,
      category: newCategory,
      isUnilateral: newUnilateral,
    });
    setBusy(false);
    if (!result) return;
    // Built locally — the context's definitions map updates on its own schedule.
    onSelect({
      id: result.id,
      canonicalName: trimmed,
      aliases: [],
      category: newCategory,
      muscleGroups: [],
      equipment: [],
      isUnilateral: newUnilateral || hasPerSideCount(trimmed),
    });
  };

  return createPortal(
    <div className="modal-backdrop modal-backdrop--library-editor" onClick={onClose}>
      <div className="exercise-picker" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="exercise-picker__search">
          <Search size={14} strokeWidth={1.5} />
          <input
            autoFocus
            className="exercise-picker__input"
            placeholder="Search the exercise library…"
            value={query}
            onChange={e => { setQuery(e.target.value); setCreating(false); }}
          />
          <button className="library-close" onClick={onClose} aria-label="Close picker">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="library-filters exercise-picker__filters">
          <button
            className={`library-filter ${category === null ? 'library-filter--active' : ''}`}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {CATEGORIES.map(c => (
            <button
              key={c}
              className={`library-filter ${category === c ? 'library-filter--active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>

        <div className="exercise-picker__results">
          {results.map(def => {
            const last = lastPerformed.get(def.canonicalName);
            const preview = defaultsPreview(def);
            return (
              <button key={def.id} className="exercise-picker__row" onClick={() => onSelect(def)}>
                <div className="exercise-picker__row-main">
                  <span className="exercise-picker__row-name">{def.canonicalName}</span>
                  <span className="exercise-picker__row-meta">
                    <span className="library-row__category">{def.category}</span>
                    {preview && <span>{preview}</span>}
                  </span>
                </div>
                <span className="exercise-picker__row-last">
                  {last ? `Last: ${format(parseISO(last), 'MMM d')}` : ''}
                </span>
              </button>
            );
          })}

          {results.length === 0 && !canCreate && (
            <p className="library-empty">No exercises match.</p>
          )}

          {canCreate && !creating && (
            <button className="exercise-picker__create-row" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={1.5} /> Create "{trimmed}" as a new exercise
            </button>
          )}

          {canCreate && creating && (
            <div className="exercise-picker__create-form">
              <span className="exercise-picker__create-name">New exercise: <strong>{trimmed}</strong></span>
              <div className="exercise-picker__create-controls">
                <select
                  className="library-field__input"
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value as ExerciseCategory)}
                >
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <label className="library-field--checkbox exercise-picker__unilateral">
                  <input type="checkbox" checked={newUnilateral} onChange={e => setNewUnilateral(e.target.checked)} />
                  <span className="library-field__label">Unilateral</span>
                </label>
                <button className="library-editor__save" onClick={createAndSelect} disabled={busy}>
                  {busy ? 'Creating…' : 'Create & add'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
