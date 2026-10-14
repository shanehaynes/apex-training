import { useContext } from 'react';
import { CheckCircle2, MessageSquare, Trophy, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import type { WorkoutEvent } from '../../types/workout';
import type { TrackedSectionGroup, TrackedSet, CardioActuals } from '../../lib/tracking/plan';
import { classifySet, describeRecordForPeople, describeWorkoutScore, formatScore, isPerformedSet } from '../../lib/tracking/records';
import type { PersonalRecord, SessionScore, WorkoutScoreRecord } from '../../lib/tracking/records';
import type { CoachStatus } from '../../hooks/useWorkoutSession';
import { useTip } from '../../hooks/useTip';
import { useCoachReachable } from '../../hooks/useCoachReachable';
import { AuthContext } from '../../context/auth';
import { DEFAULT_WEIGHT_CONTEXT, lbToUnit, type WeightContext } from '../../lib/tracking/weight';
import { ascentStyleLabel } from '../../lib/climbing';
import { parseAttempts } from '../../lib/tracking/plan';

interface Props {
  event: WorkoutEvent;
  accentColor: string;
  durationSeconds: number | null;
  groups: TrackedSectionGroup[];
  /** The note on the whole session (workout_sessions.note); '' when none. */
  sessionNote?: string;
  prs: PersonalRecord[];
  /** Workout-level score for scored events (null = unscored session). */
  score: SessionScore | null;
  /** Set when the score beat the template's history — the top trophy row. */
  scoreRecord: WorkoutScoreRecord | null;
  coachText: string | null;
  coachStatus: CoachStatus;
  /** Dismiss the popup but stay on the tracker (post-finish editing). */
  onClose: () => void;
  /** Primary action — leave the tracker and return to the calendar. */
  onDone: () => void;
  /** Leave the tracker and open the coach with this session pinned (D-C08). */
  onAskCoach: () => void;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function setLabel(set: TrackedSet): string {
  const parts: string[] = [];
  if (set.actualWeight) parts.push(set.actualWeight);
  if (set.actualReps) parts.push(`× ${set.actualReps}`);
  if (set.actualDuration) parts.push(set.actualDuration);
  return parts.join(' ');
}

/** A pitch reads as climbed: "5.10a · Redpointed · 3 tries" — the grade as logged, never a weight. */
function pitchLabel(set: TrackedSet): string {
  if (!set.actualWeight) return '';
  const tries = parseAttempts(set.attempts);
  return [
    set.actualWeight,
    ascentStyleLabel(set.ascentStyle ?? undefined),
    tries !== null ? `${tries} ${tries === 1 ? 'try' : 'tries'}` : undefined,
  ].filter(Boolean).join(' · ');
}

/** The summary's key for a record: a send is per grade scale, so one name can hold two. */
function recordKey(pr: PersonalRecord): string {
  return pr.kind === 'send' ? `send|${pr.exerciseName}|${pr.grade}` : `${pr.kind}|${pr.exerciseName}`;
}

/** Whether a set counts: not a zero-fill, not a warm-up (isPerformedSet). */
function performed(set: TrackedSet): boolean {
  return isPerformedSet({ is_autofilled: set.isAutofilled, is_warmup: set.isWarmup });
}

/**
 * Σ weight × reps over the session's working sets — the review's tonnage
 * rule, so a warm-up set adds nothing here either — read with the profile's
 * context (a bare "80" is 80 kg to a kg lifter, "BW+25" resolves against the
 * body weight) and given in its unit, to the whole unit. Null when no set
 * carried a weight and reps.
 */
function sessionTonnage(groups: TrackedSectionGroup[], ctx: WeightContext = DEFAULT_WEIGHT_CONTEXT): number | null {
  let total = 0;
  let any = false;
  for (const group of groups) {
    for (const tracked of group.exercises) {
      // A pitch's weight column is its grade: no volume in it.
      if (tracked.isCardio || tracked.exercise.category === 'climbing') continue;
      for (const set of tracked.sets) {
        if (!performed(set)) continue;
        const classified = classifySet(set.actualWeight, set.actualReps, set.actualDuration, ctx);
        if (classified?.kind !== 'oneRM') continue;
        total += classified.weight * classified.reps;
        any = true;
      }
    }
  }
  return any ? Math.round(lbToUnit(total, ctx.unit)) : null;
}

function cardioLabel(cardio: CardioActuals): string {
  const parts: string[] = [];
  if (cardio.durationMinutes) parts.push(`${cardio.durationMinutes} min`);
  if (cardio.distance) parts.push(cardio.distance);
  if (cardio.elevationGain) parts.push(`↑ ${cardio.elevationGain}`);
  if (cardio.avgHeartRate) parts.push(`${cardio.avgHeartRate} bpm`);
  return parts.join(' · ');
}

export default function WorkoutSummary({
  event,
  accentColor,
  durationSeconds,
  groups,
  sessionNote = '',
  prs,
  score,
  scoreRecord,
  coachText,
  coachStatus,
  onClose,
  onDone,
  onAskCoach,
}: Props) {
  // The provider is absent only in markup tests; the app always has one,
  // whose context is pounds until the profile loads.
  const weightContext = useContext(AuthContext)?.weightContext ?? DEFAULT_WEIGHT_CONTEXT;
  const duration = formatDuration(durationSeconds);
  const tonnage = sessionTonnage(groups, weightContext);
  // First sight of the summary: what the trophies mean, and why a first try
  // at a movement never earns one.
  useTip('summary-first');
  // Tablet widths have no coach pane and no tab to open one: no ask there.
  const coachReachable = useCoachReachable();

  return (
    <div className="tracker-summary-overlay" role="dialog" aria-modal="true" aria-label="Workout summary">
      <div className="tracker-summary" style={{ borderTop: `3px solid ${accentColor}` }}>
        <div className="tracker-summary__header">
          <span className="tracker-summary__check" style={{ color: accentColor }}>
            <CheckCircle2 size={20} strokeWidth={2} />
          </span>
          <div className="tracker-summary__titles">
            <span className="tracker-summary__heading">Workout Complete</span>
            <span className="tracker-summary__meta">
              {event.title} · {format(parseISO(event.date), 'EEE, MMM d')}
              {score ? ` · ${formatScore(score)}` : duration ? ` · ${duration}` : ''}
            </span>
            {tonnage !== null && (
              <span
                className="tracker-summary__meta"
                data-testid="summary-tonnage"
                title={`Weight × reps in ${weightContext.unit} over working sets — warm-ups and skipped sets excluded`}
              >
                Volume {tonnage.toLocaleString()}
              </span>
            )}
          </div>
          <button className="tracker-summary__close" onClick={onClose} aria-label="Close summary">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="tracker-summary__coach">
          <span className="tracker-summary__label">Coach's Summary</span>
          {/* 'loading' lasts until the stream ends — which is when the
              server has saved the summary — so the words stream in under
              that status, and the placeholder shows only before the first. */}
          {coachStatus === 'loading' && (
            coachText
              ? <p className="tracker-summary__coach-text">{coachText}</p>
              : (
                <p className="tracker-summary__coach-text tracker-summary__coach-text--loading">
                  Your coach is writing…
                </p>
              )
          )}
          {coachStatus === 'ready' && coachText && (
            <p className="tracker-summary__coach-text">{coachText}</p>
          )}
          {coachStatus === 'unavailable' && (
            <p className="tracker-summary__coach-text tracker-summary__coach-text--muted">
              Coach's summary unavailable right now — here's what you did.
            </p>
          )}
        </div>

        {sessionNote.trim() && (
          <div className="tracker-summary__coach">
            <span className="tracker-summary__label">Session notes</span>
            <p className="tracker-summary__note" data-testid="summary-session-note">{sessionNote.trim()}</p>
          </div>
        )}

        {(scoreRecord || prs.length > 0) && (
          <div className="tracker-summary__prs">
            {scoreRecord && (
              <div className="tracker-summary__pr">
                <Trophy size={14} strokeWidth={2} style={{ color: accentColor }} />
                <span>
                  <strong>{event.title}</strong> — {describeWorkoutScore(scoreRecord)}
                </span>
              </div>
            )}
            {prs.map(pr => (
              <div key={recordKey(pr)} className="tracker-summary__pr">
                <Trophy size={14} strokeWidth={2} style={{ color: accentColor }} />
                <span>
                  <strong>{pr.exerciseName}</strong> — {describeRecordForPeople(pr, weightContext.unit)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="tracker-summary__log">
          {groups.map(group => (
            <div key={group.section} className="tracker-summary__section">
              <span className="tracker-summary__label">{group.label}</span>
              {group.exercises.map(tracked => (
                <div key={tracked.exercise.id} className="tracker-summary__exercise">
                  <span className="tracker-summary__exercise-name">{tracked.exercise.name}</span>
                  {tracked.isCardio && tracked.cardio ? (
                    <span className="tracker-summary__set">
                      {cardioLabel(tracked.cardio) || <em>not logged</em>}
                    </span>
                  ) : (
                    tracked.sets.map(set => {
                      const label = tracked.exercise.category === 'climbing' ? pitchLabel(set) : setLabel(set);
                      // A warm-up is shown with what it did and a tag; only a
                      // zero-fill or an empty planned set reads as skipped.
                      const skipped = set.isAutofilled || (!label && !set.isExtra);
                      return (
                        <span key={set.setNumber} className="tracker-summary__set">
                          <span className="tracker-summary__set-num">{set.setNumber}</span>
                          {skipped || !label ? <em>skipped</em> : label}
                          {set.isWarmup && !skipped && <span className="tracker-summary__tag">warm-up</span>}
                          {set.rpe && !skipped && <span className="tracker-summary__tag">RPE {set.rpe}</span>}
                        </span>
                      );
                    })
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Two buttons in a footer the stylesheet lays out for one; the
            column is inline so this lane carries no app.css edit. The ask
            is the secondary: outlined in the accent, under the primary. */}
        <div className="tracker-summary__footer" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="tracker-summary__done" style={{ background: accentColor }} onClick={onDone}>
            Back to calendar
          </button>
          {/* Held while the coach's summary is still streaming: the ask
              promises the coach that session's own summary, and the server
              saves it only when the stream ends — an earlier ask would read
              a session without one. */}
          {coachReachable && (
            <button
              className="tracker-summary__done"
              data-testid="ask-coach-summary"
              style={{
                background: 'transparent', color: accentColor, border: `1px solid ${accentColor}`,
                ...(coachStatus === 'loading' ? { opacity: 0.5, cursor: 'default' } : {}),
              }}
              disabled={coachStatus === 'loading'}
              title={coachStatus === 'loading' ? "Available once the coach's summary is saved" : undefined}
              onClick={onAskCoach}
            >
              <MessageSquare size={14} strokeWidth={1.5} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Ask the coach about this session
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
