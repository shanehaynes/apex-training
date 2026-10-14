import { format, parseISO } from 'date-fns';
import { BookOpen, Check, Plus } from 'lucide-react';
import { DOCTRINE_TOPICS } from '../../lib/coach/doctrine';
import type { ToolPreview } from '../../lib/coach/preview';
import { formatNumber, formatTonnage } from '../../lib/review/formats';
import type {
  WeeklyDoctrine,
  WeeklyMemoryProposal,
  WeeklyNextWeekItem,
  WeeklyPhysiology,
  WeeklyPlanVsDone,
  WeeklyReviewStats,
} from '../../lib/review/weekly';

// The weekly review's sections (lane D03), one component each, every one a
// pure function of the document — the view owns the fetch and the accept
// state. Styles in weekly-review.css; the tool previews reuse the confirm
// card's classes (src/components/sidebar/confirm-preview.css) so an accepted
// change looks exactly like the change the chat would have asked to confirm.

/** What an item's Accept has done so far. */
export type AcceptState = 'idle' | 'busy' | 'done' | 'error';

const shortDay = (iso: string) => format(parseISO(iso), 'EEE MMM d');

// ─── Plan vs done ────────────────────────────────────────────────────────────

export function PlanVsDoneSection({ plan }: { plan: WeeklyPlanVsDone }) {
  const rate = plan.planned > 0 ? Math.round((plan.completed / plan.planned) * 100) : null;
  return (
    <section className="weekly-review__section" data-testid="weekly-review-plan">
      <h3 className="weekly-review__heading">Plan vs done</h3>
      <table className="weekly-review__table">
        <thead>
          <tr><th scope="col"></th><th scope="col">Planned</th><th scope="col">Done</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Sessions</th>
            <td>{plan.planned}</td>
            <td>{plan.completed}{rate !== null && <span className="weekly-review__muted"> · {rate}%</span>}</td>
          </tr>
          <tr>
            <th scope="row">Minutes</th>
            <td>{plan.minutesPlanned}</td>
            <td>{plan.minutesDone}</td>
          </tr>
        </tbody>
      </table>
      {plan.misses.length > 0 && (
        <ul className="weekly-review__misses" aria-label="Missed sessions">
          {plan.misses.map(m => (
            <li key={`${m.eventId}|${m.date}`} className="weekly-review__miss">
              <span className="weekly-review__miss-when">{shortDay(m.date)}</span>
              <span className="weekly-review__miss-title">{m.title}</span>
              {m.why && <span className="weekly-review__miss-why">{m.why}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Physiology ──────────────────────────────────────────────────────────────

export function PhysiologySection({ physiology }: { physiology: WeeklyPhysiology }) {
  return (
    <section className="weekly-review__section" data-testid="weekly-review-physiology">
      <h3 className="weekly-review__heading">Physiology</h3>
      <p className="weekly-review__text">{physiology.summary}</p>
      {physiology.flags.length > 0 && (
        <ul className="weekly-review__flags" aria-label="Flags">
          {physiology.flags.map((flag, i) => <li key={i} className="weekly-review__flag">{flag}</li>)}
        </ul>
      )}
    </section>
  );
}

// ─── Numbers ─────────────────────────────────────────────────────────────────
// The computed stats, shown with or without the coach's document: plain
// labels, no interpretation (src/lib/physiology defines no ratio bands, so
// none is named here).

const ZONE_METHOD_NOTE = {
  device: 'from device zone data',
  avgHr: 'each session counted in the zone of its average HR',
  mixed: 'device zone data where synced, else each session in the zone of its average HR',
} as const;

export function NumbersSection({ stats }: { stats: WeeklyReviewStats }) {
  const { load, hrv, zoneMinutes, zoneMethod, tonnageByWeek } = stats.physiology;
  const hasPanel = load !== null || hrv !== null || zoneMinutes !== null || tonnageByWeek.length > 0;
  return (
    <section className="weekly-review__section" data-testid="weekly-review-numbers">
      <h3 className="weekly-review__heading">Numbers</h3>

      <h4 className="weekly-review__subheading">PRs this week</h4>
      {stats.prs.length === 0 ? (
        <p className="weekly-review__muted" data-testid="weekly-review-no-prs">No PRs this week.</p>
      ) : (
        <ul className="weekly-review__misses" aria-label="PRs this week">
          {stats.prs.map((pr, i) => (
            <li key={i} className="weekly-review__miss" data-testid="weekly-review-pr">
              <span className="weekly-review__miss-when">{shortDay(pr.date)}</span>
              <span className="weekly-review__pr-title">{pr.exerciseName}</span>
              <span className="weekly-review__miss-why">{pr.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {stats.prs.some(pr => pr.kind === 'oneRM') && (
        <p className="weekly-review__muted">Lifts in {stats.weightUnit}.</p>
      )}

      <h4 className="weekly-review__subheading">Load</h4>
      {!hasPanel ? (
        <p className="weekly-review__muted">No measured data in the five weeks to {shortDay(stats.asOf)}.</p>
      ) : (
        <table className="weekly-review__table weekly-review__table--wide" data-testid="weekly-review-load">
          <tbody>
            {load && (
              <>
                <tr>
                  <th scope="row">Acute load, 7 d</th>
                  <td>{formatNumber(load.acute7d)} <span className="weekly-review__muted">{load.source === 'trainingLoad' ? 'device load' : 'cardio min'}</span></td>
                </tr>
                <tr>
                  <th scope="row">Chronic load, 28 d weekly avg</th>
                  <td>{formatNumber(load.chronicWeeklyAvg28d)}</td>
                </tr>
                <tr>
                  <th scope="row">Acute : chronic</th>
                  <td data-testid="weekly-review-acwr">{load.ratio === null ? <span className="weekly-review__muted">n/a, no 28 d baseline</span> : load.ratio.toFixed(2)}</td>
                </tr>
              </>
            )}
            {hrv && (
              <tr>
                <th scope="row">HRV, 7 d vs 28 d mean</th>
                <td data-testid="weekly-review-hrv">
                  {hrv.mean7d === null ? <span className="weekly-review__muted">no reading, 7 d</span> : `${formatNumber(hrv.mean7d)} ms`}
                  {' vs '}{formatNumber(hrv.mean28d)} ms
                </td>
              </tr>
            )}
            {zoneMinutes && (
              <tr>
                <th scope="row">Zone minutes Z1–Z5</th>
                <td data-testid="weekly-review-zones">
                  {zoneMinutes.join(' / ')}
                  {zoneMethod && <span className="weekly-review__muted"> · {ZONE_METHOD_NOTE[zoneMethod]}</span>}
                </td>
              </tr>
            )}
            {tonnageByWeek.length > 0 && (
              <tr>
                <th scope="row">Tonnage by week</th>
                <td>
                  <ol className="weekly-review__tonnage" aria-label="Tonnage by week, oldest first">
                    {tonnageByWeek.map(w => (
                      <li key={w.weekStart} data-testid="weekly-review-tonnage-week">
                        <span className="weekly-review__muted">{format(parseISO(w.weekStart), 'MMM d')}</span>{' '}
                        {w.tonnageLb === null ? '—' : formatTonnage(w.tonnageLb, stats.weightUnit)}
                      </li>
                    ))}
                  </ol>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <p className="weekly-review__muted" data-testid="weekly-review-asof">Load as of {shortDay(stats.asOf)}.</p>
    </section>
  );
}

// ─── Doctrine ────────────────────────────────────────────────────────────────

const VERDICT_LABEL = { aligned: 'Aligned', drifting: 'Drifting', contradicted: 'Contradicted' } as const;

export function DoctrineSection({ doctrine }: { doctrine: WeeklyDoctrine | null }) {
  const title = doctrine ? DOCTRINE_TOPICS.find(t => t.id === doctrine.topic)?.title ?? doctrine.topic : null;
  return (
    <section className="weekly-review__section" data-testid="weekly-review-doctrine">
      <h3 className="weekly-review__heading">Doctrine check</h3>
      {doctrine ? (
        <div className={`weekly-review__doctrine weekly-review__doctrine--${doctrine.verdict}`}>
          <div className="weekly-review__doctrine-head">
            <BookOpen size={13} strokeWidth={1.5} aria-hidden="true" />
            <span className="weekly-review__doctrine-topic">{title}</span>
            <span className="weekly-review__verdict" data-verdict={doctrine.verdict}>{VERDICT_LABEL[doctrine.verdict]}</span>
          </div>
          <blockquote className="weekly-review__quote">{doctrine.line}</blockquote>
          {doctrine.note && <p className="weekly-review__text">{doctrine.note}</p>}
        </div>
      ) : (
        <p className="weekly-review__muted">No doctrine check this week.</p>
      )}
    </section>
  );
}

// ─── Memory proposals ────────────────────────────────────────────────────────

interface MemoryProps {
  proposals: WeeklyMemoryProposal[];
  states: AcceptState[];
  onRemember: (index: number) => void;
}

export function MemoryProposalsSection({ proposals, states, onRemember }: MemoryProps) {
  if (proposals.length === 0) return null;
  return (
    <section className="weekly-review__section" data-testid="weekly-review-memory">
      <h3 className="weekly-review__heading">Worth remembering</h3>
      <p className="weekly-review__muted">Nothing is remembered until you say so.</p>
      <ul className="weekly-review__cards">
        {proposals.map((p, i) => {
          const state = states[i] ?? 'idle';
          return (
            <li key={i} className={`weekly-review__card${state === 'done' ? ' weekly-review__card--done' : ''}`} data-testid="memory-proposal">
              <div className="weekly-review__card-body">
                <span className="weekly-review__kind">{p.kind}</span>
                <p className="weekly-review__card-title">{p.content}</p>
                {p.why && <p className="weekly-review__why">{p.why}</p>}
              </div>
              <AcceptButton state={state} label="Remember" doneLabel="Remembered" onClick={() => onRemember(i)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Next week ───────────────────────────────────────────────────────────────

/** The confirm card's before/after block, for the two tools a proposal may name. */
function ProposalPreview({ preview }: { preview: ToolPreview | null }) {
  if (!preview) return null;
  if (preview.kind === 'event-create') {
    const when = [preview.date, preview.time].filter(Boolean).join(' · ');
    const facts = [
      preview.durationMinutes !== undefined ? `${preview.durationMinutes} min` : null,
      preview.type ?? null,
    ].filter(Boolean).join(' · ');
    return (
      <div className="confirm-preview" data-testid="confirm-preview" data-kind={preview.kind}>
        <p className="confirm-preview__line"><strong>{when}</strong>{facts ? ` · ${facts}` : ''}</p>
        {preview.repeat && <p className="confirm-preview__line">{preview.repeat}</p>}
        {preview.exercises.length > 0 && (
          <ul className="confirm-preview__list confirm-preview__list--after">
            {preview.exercises.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
      </div>
    );
  }
  if (preview.kind === 'event-update') {
    return (
      <div className="confirm-preview" data-testid="confirm-preview" data-kind={preview.kind}>
        <dl className="confirm-preview__changes">
          {preview.changes.map(c => (
            <div key={c.field} style={{ display: 'contents' }}>
              <dt className="confirm-preview__field">{c.field}</dt>
              <dd className="confirm-preview__diff">
                <span className="confirm-preview__before">{c.before}</span>
                <span className="confirm-preview__arrow" aria-hidden="true">→</span>
                <span className="confirm-preview__after">{c.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  return null;
}

export interface NextWeekCard {
  item: WeeklyNextWeekItem;
  /** The confirm card's one-line label, resolved against live state. */
  label: string;
  preview: ToolPreview | null;
}

interface NextWeekProps {
  cards: NextWeekCard[];
  states: AcceptState[];
  onAccept: (index: number) => void;
}

export function NextWeekSection({ cards, states, onAccept }: NextWeekProps) {
  return (
    <section className="weekly-review__section" data-testid="weekly-review-next-week">
      <h3 className="weekly-review__heading">Next week</h3>
      {cards.length === 0 ? (
        <p className="weekly-review__muted">No changes proposed — next week stands as scheduled.</p>
      ) : (
        <>
          <p className="weekly-review__muted">Each change is applied only when you accept it.</p>
          <ul className="weekly-review__cards">
            {cards.map((card, i) => {
              const state = states[i] ?? 'idle';
              return (
                <li key={i} className={`weekly-review__card${state === 'done' ? ' weekly-review__card--done' : ''}`} data-testid="next-week-item" data-tool={card.item.tool}>
                  <div className="weekly-review__card-body">
                    <p className="weekly-review__card-title">{card.label}</p>
                    <ProposalPreview preview={card.preview} />
                    {card.item.why && <p className="weekly-review__why">{card.item.why}</p>}
                  </div>
                  <AcceptButton state={state} label="Accept" doneLabel="Accepted" onClick={() => onAccept(i)} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────────

interface AcceptButtonProps {
  state: AcceptState;
  label: string;
  doneLabel: string;
  onClick: () => void;
}

function AcceptButton({ state, label, doneLabel, onClick }: AcceptButtonProps) {
  const done = state === 'done';
  return (
    <button
      className={`weekly-review__accept${done ? ' weekly-review__accept--done' : ''}`}
      onClick={onClick}
      disabled={state === 'busy' || done}
      aria-label={label}
      data-state={state}
    >
      {done ? <Check size={12} /> : <Plus size={12} />}
      {done ? doneLabel : state === 'busy' ? 'Applying…' : state === 'error' ? 'Retry' : label}
    </button>
  );
}
