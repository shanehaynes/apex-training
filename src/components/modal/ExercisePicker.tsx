import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { format, parseISO } from 'date-fns';
import { Search, X } from 'lucide-react';
import { useSchedule } from '../../context/schedule';
import { buildAliasIndex, matchDefinitionByName, nearMatchDefinitions } from '../../lib/schedule/definitions';
import { fetchLastPerformedRows } from '../../lib/library/repo';
import { lastPerformedByCanonical } from '../../lib/library/stats';
import CreateDefinitionInline from './CreateDefinitionInline';
import type { ExerciseCategory, ExerciseDefinition } from '../../types/workout';

interface Props {
  onSelect: (def: ExerciseDefinition) => void;
  onClose: () => void;
  /** Pre-selects a category filter aligned with the workout type (clearable). */
  initialCategory?: ExerciseCategory;
  /**
   * Hard limit on what can be picked — the chips, the results and the
   * create-new category are all confined to these. Used by the tracker's
   * swap, where the replacement has to log the same shape as what it
   * replaces (per-set rows vs one cardio row).
   */
  restrictTo?: ExerciseCategory[];
  /**
   * The create form's starting category when no chip is pre-selected — a
   * swap starts from the replaced movement's, without narrowing the search.
   */
  createCategory?: ExerciseCategory;
}

const ALL_CATEGORIES: ExerciseCategory[] = ['strength', 'stretch', 'mobility', 'skill', 'cardio', 'climbing'];

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
export default function ExercisePicker({ onSelect, onClose, initialCategory, restrictTo, createCategory }: Props) {
  const { definitions } = useSchedule();
  const categories = restrictTo?.length ? restrictTo : ALL_CATEGORIES;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ExerciseCategory | null>(initialCategory ?? null);
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

  // What could be picked at all here, before the search narrows it.
  const pickable = useMemo(() =>
    [...definitions.values()]
      .filter(def => !def.archivedAt)
      .filter(def => categories.includes(def.category))
      .filter(def => !category || def.category === category),
  [definitions, category, categories]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pickable
      .filter(def =>
        !needle ||
        def.canonicalName.toLowerCase().includes(needle) ||
        def.aliases.some(a => a.toLowerCase().includes(needle)) ||
        def.muscleGroups.some(m => m.toLowerCase().includes(needle)))
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  }, [pickable, query]);

  const trimmed = query.trim();
  // Offer create only when the query is no existing name/alias — an exact
  // match should be selected, not duplicated.
  const canCreate = trimmed.length > 1 && !matchDefinitionByName(trimmed, definitions.values());
  // Substring search misses typos ("Pnacake Fold"), and a typo that reaches
  // Create forks the movement's history — so name the likely target first.
  const nearMatches = useMemo(() => {
    if (!canCreate) return [];
    const shown = new Set(results.map(def => def.id));
    return nearMatchDefinitions(trimmed, pickable.filter(def => !shown.has(def.id)));
  }, [canCreate, trimmed, pickable, results]);

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
            onChange={e => setQuery(e.target.value)}
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
          {categories.map(c => (
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

          {nearMatches.map(def => (
            <button key={def.id} className="exercise-picker__row" onClick={() => onSelect(def)}>
              <div className="exercise-picker__row-main">
                <span className="exercise-picker__row-name">{def.canonicalName}</span>
                <span className="exercise-picker__row-meta">
                  <span className="library-row__category">{def.category}</span>
                  <span>did you mean?</span>
                </span>
              </div>
            </button>
          ))}

          {results.length === 0 && !canCreate && (
            <p className="library-empty">No exercises match.</p>
          )}

          {canCreate && (
            <CreateDefinitionInline
              name={trimmed}
              categories={categories}
              initialCategory={[initialCategory, createCategory].find(c => c && categories.includes(c)) ?? categories[0]}
              anyway={nearMatches.length > 0 || results.length > 0}
              confirmLabel="Create & add"
              onCreated={onSelect}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
