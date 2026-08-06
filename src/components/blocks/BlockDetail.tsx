import { useEffect, useState } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { useSchedule } from '../../context/ScheduleContext';
import { useBlocks } from '../../context/BlocksContext';
import { computeBlockProgress } from '../../lib/blocks/progress';
import type { BlockProgress } from '../../lib/blocks/progress';
import { loadBlockLogs } from '../../lib/blocks/repo';
import { blockPeriod } from '../../lib/blocks/period';
import { describeRecord } from '../../lib/tracking/records';
import { now } from '../../lib/clock';
import type { TrainingBlock } from '../../types/blocks';
import BlockProgressBars from './BlockProgressBars';

export default function BlockDetail({
  block,
  onBack,
  onClose,
  onEdit,
}: {
  block: TrainingBlock;
  onBack: () => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { events } = useSchedule();
  const { objectiveFor } = useBlocks();
  const [progress, setProgress] = useState<BlockProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    const period = blockPeriod(block);
    loadBlockLogs(block)
      .then(logs => {
        if (cancelled) return;
        setProgress(
          computeBlockProgress(
            {
              period,
              ...logs,
              block,
              // Expanded occurrences inside the window are the source of the
              // calendar-derived fallback for any target left unauthored.
              plannedEvents: events.filter(
                e => e.date >= period.startDate && e.date < period.endDateExclusive,
              ),
            },
            now(),
          ),
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [block, events]);

  const objective = objectiveFor(block);
  const currentWeek = progress?.currentWeek ?? null;

  return (
    <div className="library-view">
      <header className="library-header">
        <div className="library-header__titles">
          <button className="library-back" onClick={onBack} aria-label="Back to blocks">
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          <h2 className="library-header__title">{block.name}</h2>
          <span className="library-header__count">
            {currentWeek ? `week ${currentWeek} of ${progress?.weeksTotal}` : blockPeriod(block).label}
          </span>
        </div>
        <div className="library-header__actions">
          <button className="library-edit-btn" onClick={onEdit}>Edit</button>
          <button className="library-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>


      <div className="block-detail">
        {(block.intent || objective) && (
          <section className="block-section">
            {objective && (
              <p className="block-objective">
                Objective: <strong>{objective.name}</strong>
                {objective.targetDate && <span className="block-objective__date"> · {objective.targetDate}</span>}
              </p>
            )}
            {block.intent && <p className="block-intent">{block.intent}</p>}
          </section>
        )}

        {!progress ? (
          <p className="block-empty" aria-busy="true">Loading…</p>
        ) : (
          <>
            <section className="block-section">
              <h3 className="block-section__title">
                Block to date
                <span className="block-section__sub">
                  {progress.weeksElapsed} of {progress.weeksTotal} weeks complete
                </span>
              </h3>
              {progress.weeksElapsed === 0 ? (
                <p className="block-empty">No completed weeks yet.</p>
              ) : (
                <BlockProgressBars attainment={progress.toDate.attainment} />
              )}
            </section>

            {currentWeek && (
              <section className="block-section">
                <h3 className="block-section__title">
                  This week
                  <span className="block-section__sub">week {currentWeek}, in progress</span>
                </h3>
                <BlockProgressBars attainment={progress.weeks[currentWeek - 1].attainment} />
              </section>
            )}

            <section className="block-section">
              <h3 className="block-section__title">By week</h3>
              <table className="block-weeks">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Starting</th>
                    <th>Sessions</th>
                    <th>Attainment</th>
                  </tr>
                </thead>
                <tbody>
                  {progress.weeks.map(week => (
                    <tr key={week.index} className={week.index === currentWeek ? 'block-weeks__row--current' : ''}>
                      <td>{week.index}</td>
                      <td className="block-weeks__date">{week.startDate}</td>
                      <td>{week.sessionsCompleted}</td>
                      <td className="block-weeks__attainment">
                        {week.attainment.length === 0
                          ? '—'
                          : week.attainment
                              .map(a => `${a.label.toLowerCase()} ${a.pct === null ? '—' : `${Math.round(a.pct * 100)}%`}`)
                              .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {progress.prs.length > 0 && (
              <section className="block-section">
                <h3 className="block-section__title">
                  PRs this block
                  <span className="block-section__sub">{progress.prs.length}</span>
                </h3>
                <ul className="block-prs">
                  {progress.prs.map((pr, i) => (
                    <li key={`${pr.exerciseName}-${pr.date}-${i}`}>
                      <span className="block-prs__date">{pr.date}</span>{' '}
                      <strong>{pr.exerciseName}</strong> — {describeRecord(pr)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
