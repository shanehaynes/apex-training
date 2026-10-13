import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, MessageSquareText, Search, Timer, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useCalendar } from '../../context/calendar';
import { useSchedule } from '../../context/schedule';
import { WORKOUT_COLORS } from '../../utils/workoutColors';
import { formatElapsed } from '../../lib/time';
import type { WorkoutType } from '../../types/workout';
import { listSessions, type SessionListRow } from './sessionsApi';
import { eventForSession, isWorkoutType } from './sessionEvent';
import '../../styles/history.css';

// The workout history: every tracked session, newest first, paged through
// list_sessions. Tapping a row opens the tracker in view mode — the session
// is bootstrapped server-side by (eventId, eventDate), so a row months older
// than anything the calendar holds opens all the same.

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;
const TYPE_FILTERS: Array<WorkoutType | 'all'> = ['all', ...(Object.keys(WORKOUT_COLORS) as WorkoutType[])];

function scoreLabel(score: SessionListRow['score']): string | null {
  if (!score) return null;
  if (score.type === 'for-time' && score.timeSeconds != null) return formatElapsed(score.timeSeconds);
  if (score.type === 'amrap' && score.rounds != null) return `${score.rounds} rounds${score.reps ? ` + ${score.reps}` : ''}`;
  return null;
}

export default function HistoryView() {
  const { dispatch } = useCalendar();
  const { events } = useSchedule();
  const close = () => dispatch({ type: 'CLOSE_HISTORY' });
  useModalChrome(close);

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState<WorkoutType | 'all'>('all');
  const [rows, setRows] = useState<SessionListRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Bumped by every filter change so a slow earlier page cannot land on a
  // newer filter's list.
  const requestRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo(() => ({ limit: PAGE_SIZE, q: q || undefined, type: type === 'all' ? undefined : type }), [q, type]);

  const load = useCallback(async (cursor: string | null) => {
    const id = ++requestRef.current;
    setLoading(true);
    try {
      const page = await listSessions({ ...query, cursor: cursor ?? undefined });
      if (id !== requestRef.current) return;
      setRows(prev => (cursor ? [...prev, ...page.sessions] : page.sessions));
      setNextCursor(page.nextCursor);
      setFailed(false);
    } catch {
      if (id !== requestRef.current) return;
      if (!cursor) setRows([]);
      setNextCursor(null);
      setFailed(true);
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(null); }, [load]);

  const open = (row: SessionListRow) => {
    dispatch({ type: 'START_TRACKING', payload: eventForSession(row, events) });
  };

  const filtered = q || type !== 'all';

  return (
    <div className="history-view" data-testid="history-view">
      <header className="history-header">
        <div className="history-header__titles">
          <h1 className="history-header__title">Workout History</h1>
          {rows.length > 0 && (
            <span className="history-header__count">{rows.length}{nextCursor ? '+' : ''} sessions</span>
          )}
        </div>
        <button className="history-close" onClick={close} aria-label="Close history">
          <X size={18} strokeWidth={1.5} />
        </button>
      </header>

      <div className="history-controls">
        <div className="history-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            type="text"
            className="history-search__input"
            placeholder="Search by title…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search sessions"
          />
        </div>
        <div className="history-filters">
          {TYPE_FILTERS.map(t => (
            <button
              key={t}
              className={`history-filter ${type === t ? 'history-filter--active' : ''}`}
              onClick={() => setType(t)}
            >
              {t === 'all' ? 'All' : WORKOUT_COLORS[t].label}
            </button>
          ))}
        </div>
      </div>

      <div className="history-list">
        {rows.map(row => {
          const color = isWorkoutType(row.type) ? WORKOUT_COLORS[row.type] : null;
          const score = scoreLabel(row.score);
          return (
            <button key={row.id} className="history-row" onClick={() => open(row)}>
              <span className="history-row__swatch" style={{ background: color?.solid ?? 'var(--border-subtle)' }} />
              <div className="history-row__main">
                <span className="history-row__title">{row.title}</span>
                <span className="history-row__meta">
                  <span className="history-row__date">{format(parseISO(row.eventDate), 'EEE, MMM d, yyyy')}</span>
                  {color && <span className="history-row__type">{color.label}</span>}
                  {row.sport && <span>{row.sport}</span>}
                  {score && <span className="history-row__score">{score}</span>}
                </span>
              </div>
              <div className="history-row__stats">
                {row.durationSeconds != null && (
                  <span className="history-row__duration">
                    <Timer size={12} strokeWidth={1.5} /> {formatElapsed(row.durationSeconds)}
                  </span>
                )}
                {!row.finishedAt && <span className="history-row__open">In progress</span>}
                {row.hasSummary && (
                  <span className="history-row__summary" title="Coach summary">
                    <MessageSquareText size={12} strokeWidth={1.5} /> Summary
                  </span>
                )}
              </div>
              <ChevronRight size={16} strokeWidth={1.5} className="history-row__chevron" />
            </button>
          );
        })}

        {!loading && rows.length === 0 && (
          <div className="history-empty">
            {failed
              ? 'Could not load your history. Try again in a moment.'
              : filtered
              ? 'No sessions match. Clear the search or pick another type.'
              : 'No tracked sessions yet. Start a workout from the calendar and it will show up here.'}
          </div>
        )}

        {loading && <div className="history-loading">Loading…</div>}

        {!loading && nextCursor && (
          <button className="history-more" onClick={() => load(nextCursor)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
