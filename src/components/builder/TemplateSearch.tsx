import { useMemo, useState } from 'react';
import { ChevronRight, Plus, Search, Timer, Trophy, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import { TYPE_ORDER } from '../../lib/builder/draft';
import type { WorkoutTemplate, WorkoutType } from '../../types/workout';

interface Props {
  templates: Map<string, WorkoutTemplate>;
  /** The day being scheduled (yyyy-MM-dd) — every action here lands on it. */
  date: string;
  onPick: (template: WorkoutTemplate) => void;
  onCreateNew: (title: string) => void;
  onArchive: (id: string) => Promise<boolean>;
}

/** One-line scoring descriptor for a template card; strength stays silent. */
function scoringBadge(t: WorkoutTemplate): { icon: typeof Timer; label: string } | null {
  if (t.scoringType === 'for-time') return { icon: Timer, label: 'For Time' };
  if (t.scoringType === 'amrap') {
    return { icon: Trophy, label: t.timeCapMinutes ? `AMRAP ${t.timeCapMinutes} min` : 'AMRAP' };
  }
  return null;
}

function exerciseCount(t: WorkoutTemplate): number {
  return (t.warmup?.length ?? 0) + t.exercises.length + (t.cooldown?.length ?? 0);
}

/**
 * Search-first step of the workout builder. Substring match over title and
 * tags (the ExercisePicker rule: deliberately never fuzzy, so near-matches
 * are seen before "Create new" invites a duplicate). Archived templates stay
 * out of the list; reapplying an archived title from the form revives it.
 */
export default function TemplateSearch({ templates, date, onPick, onCreateNew, onArchive }: Props) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<WorkoutType | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...templates.values()]
      .filter(t => !t.archivedAt)
      .filter(t => !typeFilter || t.type === typeFilter)
      .filter(t => !q
        || t.title.toLowerCase().includes(q)
        || t.tags.some(tag => tag.toLowerCase().includes(q)))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [templates, query, typeFilter]);

  return (
    <div className="builder-search">
      {/* The step's job in one line — without it this page reads as a
          template manager rather than "put a workout on this day". */}
      <p className="builder-search__intro">
        Scheduling for <strong>{format(parseISO(date), 'EEEE, MMM d')}</strong> — pick
        a saved workout, or build a new one. Repeats of the same workout share one PR history.
      </p>

      <div className="library-search">
        <Search size={16} strokeWidth={1.5} />
        <input
          className="library-search__input"
          placeholder="Find a saved workout…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="library-filters builder-search__filters">
        <button
          className={`library-filter${typeFilter === null ? ' library-filter--active' : ''}`}
          onClick={() => setTypeFilter(null)}
        >
          All
        </button>
        {TYPE_ORDER.map(t => {
          const c = WORKOUT_COLORS[t];
          const active = typeFilter === t;
          return (
            <button
              key={t}
              className={`library-filter${active ? ' library-filter--active' : ''}`}
              style={active ? { borderColor: c.solid, color: c.solid } : undefined}
              onClick={() => setTypeFilter(active ? null : t)}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="builder-search__list">
        {rows.length > 0 && (
          <span className="builder-search__label">Your workouts — tap to schedule</span>
        )}
        {rows.map(t => {
          const c = WORKOUT_COLORS[t.type];
          const badge = scoringBadge(t);
          const count = exerciseCount(t);
          return (
            <div key={t.id} className="builder-template-card">
              <button className="builder-template-card__main" onClick={() => onPick(t)}>
                <span className="builder-template-card__dot" style={{ background: c.solid }} />
                <span className="builder-template-card__name">{t.title}</span>
                <span className="builder-template-card__meta">
                  {badge && (
                    <span className="builder-template-card__badge" style={{ color: c.solid }}>
                      <badge.icon size={12} strokeWidth={1.5} /> {badge.label}
                    </span>
                  )}
                  {count > 0 && <span>{count} exercise{count === 1 ? '' : 's'}</span>}
                </span>
                <span className="builder-template-card__go">
                  <ChevronRight size={14} strokeWidth={1.5} />
                </span>
              </button>
              <button
                className="builder-template-card__archive"
                onClick={() => onArchive(t.id)}
                aria-label={`Remove ${t.title} from library`}
                title="Remove from library"
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="builder-search__empty">
            {templates.size === 0
              ? "Nothing saved yet — build this day's workout below; Apply saves it to your library for next time."
              : 'No workouts match — build it once and it will be here from now on.'}
          </p>
        )}
      </div>

      <button className="builder-search__create" onClick={() => onCreateNew(query.trim())}>
        <Plus size={16} strokeWidth={1.5} />
        {query.trim() ? `Build “${query.trim()}”` : 'Build a new workout'}
      </button>
    </div>
  );
}
