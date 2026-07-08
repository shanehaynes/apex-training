import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, X, Pencil, Trophy } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useSchedule } from '../../context/ScheduleContext';
import { buildAliasIndex, canonicalizeLogNames, countDefinitionReferences } from '../../lib/schedule/definitions';
import { fetchExerciseHistory } from '../../lib/library/repo';
import { buildExerciseStats, formatStatDate, formatTrendValue, type ExerciseStats } from '../../lib/library/stats';
import DefinitionEditor from './DefinitionEditor';
import type { ExerciseDefinition } from '../../types/workout';

interface Props {
  definition: ExerciseDefinition;
  onBack: () => void;
  onClose: () => void;
}

function TrendTooltip({ active, payload, stats }: { active?: boolean; payload?: Array<{ payload: { date: string; value: number } }>; stats: ExerciseStats }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip__week">{format(parseISO(point.date), 'MMM d, yyyy')}</p>
      <p className="chart-tooltip__count">
        {formatTrendValue(stats.kind, point.value, stats.kind === 'distance' ? stats.kindLabel : '')}
        {stats.kind === 'oneRM' ? ' est. 1RM' : ''}
      </p>
    </div>
  );
}

export default function ExerciseDetail({ definition, onBack, onClose }: Props) {
  const { definitions, events } = useSchedule();
  const [stats, setStats] = useState<ExerciseStats | null>(null);
  const [editing, setEditing] = useState(false);

  const referenceCount = useMemo(
    () => countDefinitionReferences(definition.id, events),
    [definition.id, events],
  );

  useEffect(() => {
    let cancelled = false;
    const index = buildAliasIndex(definitions.values());
    const spellings = index.spellings.get(definition.canonicalName) ?? [definition.canonicalName];
    fetchExerciseHistory(spellings)
      .then(({ setRows, cardioRows }) => {
        if (cancelled) return;
        setStats(buildExerciseStats(
          canonicalizeLogNames(setRows, index),
          canonicalizeLogNames(cardioRows, index),
        ));
      })
      .catch(() => { if (!cancelled) setStats(buildExerciseStats([], [])); });
    return () => { cancelled = true; };
  }, [definition, definitions]);

  const trendData = stats?.trend ?? [];

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="library-header__titles">
          <button className="library-back" onClick={onBack} aria-label="Back to library">
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>
          <h1 className="library-header__title">{definition.canonicalName}</h1>
          {definition.archivedAt && <span className="library-detail__archived-badge">archived</span>}
        </div>
        <div className="library-header__actions">
          <button className="library-edit-btn" onClick={() => setEditing(true)}>
            <Pencil size={13} strokeWidth={1.5} /> Edit
          </button>
          <button className="library-close" onClick={onClose} aria-label="Close library">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="library-detail">
        <div className="library-detail__meta">
          <span className="library-row__category">{definition.category}</span>
          {definition.isUnilateral && <span className="library-detail__tag">per side</span>}
          {definition.muscleGroups.map(m => <span key={m} className="library-detail__tag">{m}</span>)}
          {definition.equipment.map(eq => <span key={eq} className="library-detail__tag library-detail__tag--equipment">{eq}</span>)}
          <span className="library-detail__refs">in {referenceCount} workout{referenceCount === 1 ? '' : 's'}</span>
        </div>

        {definition.aliases.length > 0 && (
          <p className="library-detail__aliases">Also known as: {definition.aliases.join(', ')}</p>
        )}

        {definition.techniqueNotes && (
          <p className="library-detail__notes">{definition.techniqueNotes}</p>
        )}

        {stats === null ? (
          <p className="library-empty">Loading history…</p>
        ) : stats.totalSessions === 0 ? (
          <p className="library-empty">No logged history yet.</p>
        ) : (
          <>
            <div className="library-stat-cards">
              {stats.pr && (
                <div className="library-stat-card">
                  <span className="library-stat-card__label"><Trophy size={12} strokeWidth={1.5} /> Best {stats.kindLabel}</span>
                  <span className="library-stat-card__value">{stats.pr.display}</span>
                  <span className="library-stat-card__sub">{formatStatDate(stats.pr.date)}</span>
                </div>
              )}
              <div className="library-stat-card">
                <span className="library-stat-card__label">Sessions</span>
                <span className="library-stat-card__value">{stats.totalSessions}</span>
                {stats.sessions[0] && (
                  <span className="library-stat-card__sub">last {formatStatDate(stats.sessions[0].date)}</span>
                )}
              </div>
            </div>

            {trendData.length >= 2 && (
              <div className="library-chart">
                <h3 className="library-section-heading">{stats.kindLabel} over time</h3>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <XAxis
                      dataKey="date"
                      tickFormatter={d => format(parseISO(d), 'MMM d')}
                      tick={{ fill: '#8a7f7c', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      domain={['auto', 'auto']}
                      tick={{ fill: '#8a7f7c', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip content={<TrendTooltip stats={stats} />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#f97316"
                      strokeWidth={1.5}
                      dot={{ r: 2, fill: '#f97316', strokeWidth: 0 }}
                      activeDot={{ r: 3.5 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="library-sessions">
              <h3 className="library-section-heading">Recent sessions</h3>
              {stats.sessions.map(session => (
                <div key={session.date} className="library-session">
                  <span className="library-session__date">{format(parseISO(session.date), 'EEE MMM d, yyyy')}</span>
                  <span className="library-session__sets">{session.sets.join('  ·  ')}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {editing && (
        <DefinitionEditor
          definition={definition}
          referenceCount={referenceCount}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
