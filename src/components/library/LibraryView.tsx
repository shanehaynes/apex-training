import { useEffect, useMemo, useState } from 'react';
import { X, Search, ChevronRight, Archive } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { buildAliasIndex, countDefinitionReferences } from '../../lib/schedule/definitions';
import { fetchLastPerformedRows } from '../../lib/library/repo';
import { lastPerformedByCanonical } from '../../lib/library/stats';
import ExerciseDetail from './ExerciseDetail';
import type { ExerciseCategory, ExerciseDefinition } from '../../types/workout';

const CATEGORY_FILTERS: (ExerciseCategory | 'all')[] = ['all', 'strength', 'stretch', 'mobility', 'skill', 'cardio'];

export default function LibraryView() {
  const { state, dispatch } = useCalendar();
  const { definitions, events } = useSchedule();
  const close = () => dispatch({ type: 'CLOSE_LIBRARY' });

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ExerciseCategory | 'all'>('all');
  const [detailId, setDetailId] = useState<string | null>(state.librarySelection);
  const [lastPerformed, setLastPerformed] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aliasIndex = useMemo(() => buildAliasIndex(definitions.values()), [definitions]);

  useEffect(() => {
    let cancelled = false;
    fetchLastPerformedRows()
      .then(rows => { if (!cancelled) setLastPerformed(lastPerformedByCanonical(rows, aliasIndex.toCanonical)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [aliasIndex]);

  const referenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const def of definitions.values()) counts.set(def.id, countDefinitionReferences(def.id, events));
    return counts;
  }, [definitions, events]);

  const { active, archived } = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (def: ExerciseDefinition) =>
      (category === 'all' || def.category === category) &&
      (!needle ||
        def.canonicalName.toLowerCase().includes(needle) ||
        def.aliases.some(a => a.toLowerCase().includes(needle)) ||
        def.muscleGroups.some(m => m.toLowerCase().includes(needle)));
    const all = [...definitions.values()]
      .filter(matches)
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
    return {
      active: all.filter(d => !d.archivedAt),
      archived: all.filter(d => d.archivedAt),
    };
  }, [definitions, search, category]);

  const detail = detailId ? definitions.get(detailId) : undefined;
  if (detail) {
    return <ExerciseDetail definition={detail} onBack={() => setDetailId(null)} onClose={close} />;
  }

  const renderRow = (def: ExerciseDefinition) => {
    const last = lastPerformed.get(def.canonicalName);
    const refs = referenceCounts.get(def.id) ?? 0;
    return (
      <button key={def.id} className="library-row" onClick={() => setDetailId(def.id)}>
        <div className="library-row__main">
          <span className="library-row__name">{def.canonicalName}</span>
          <span className="library-row__meta">
            <span className="library-row__category">{def.category}</span>
            {def.muscleGroups.length > 0 && <span>{def.muscleGroups.join(', ')}</span>}
          </span>
        </div>
        <div className="library-row__stats">
          <span className="library-row__last">
            {last ? `Last: ${format(parseISO(last), 'MMM d')}` : 'Never logged'}
          </span>
          <span className="library-row__refs">{refs > 0 ? `in ${refs} workout${refs === 1 ? '' : 's'}` : 'unused'}</span>
        </div>
        <ChevronRight size={16} strokeWidth={1.5} className="library-row__chevron" />
      </button>
    );
  };

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="library-header__titles">
          <h1 className="library-header__title">Exercise Library</h1>
          <span className="library-header__count">{active.length} exercises</span>
        </div>
        <button className="library-close" onClick={close} aria-label="Close library">
          <X size={18} strokeWidth={1.5} />
        </button>
      </header>

      <div className="library-controls">
        <div className="library-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            type="text"
            className="library-search__input"
            placeholder="Search exercises…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="library-filters">
          {CATEGORY_FILTERS.map(c => (
            <button
              key={c}
              className={`library-filter ${category === c ? 'library-filter--active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="library-list">
        {active.length === 0 && archived.length === 0 && (
          <p className="library-empty">No exercises match.</p>
        )}
        {active.map(renderRow)}
        {archived.length > 0 && (
          <>
            <div className="library-list__divider">
              <Archive size={12} strokeWidth={1.5} /> Archived
            </div>
            {archived.map(renderRow)}
          </>
        )}
      </div>
    </div>
  );
}
