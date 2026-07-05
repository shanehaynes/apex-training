import { CheckCircle2, Trophy, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import type { WorkoutEvent } from '../../types/workout';
import type { TrackedSectionGroup, TrackedSet, CardioActuals } from '../../lib/tracking/plan';
import { describeRecord } from '../../lib/tracking/records';
import type { PersonalRecord } from '../../lib/tracking/records';
import type { CoachStatus } from '../../hooks/useWorkoutSession';

interface Props {
  event: WorkoutEvent;
  accentColor: string;
  durationSeconds: number | null;
  groups: TrackedSectionGroup[];
  prs: PersonalRecord[];
  coachText: string | null;
  coachStatus: CoachStatus;
  /** Dismiss the popup but stay on the tracker (post-finish editing). */
  onClose: () => void;
  /** Primary action — leave the tracker and return to the calendar. */
  onDone: () => void;
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
  prs,
  coachText,
  coachStatus,
  onClose,
  onDone,
}: Props) {
  const duration = formatDuration(durationSeconds);

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
              {duration ? ` · ${duration}` : ''}
            </span>
          </div>
          <button className="tracker-summary__close" onClick={onClose} aria-label="Close summary">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="tracker-summary__coach">
          <span className="tracker-summary__label">Coach's Summary</span>
          {coachStatus === 'loading' && (
            <p className="tracker-summary__coach-text tracker-summary__coach-text--loading">
              Your coach is writing…
            </p>
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

        {prs.length > 0 && (
          <div className="tracker-summary__prs">
            {prs.map(pr => (
              <div key={`${pr.kind}|${pr.exerciseName}`} className="tracker-summary__pr">
                <Trophy size={14} strokeWidth={2} style={{ color: accentColor }} />
                <span>
                  <strong>{pr.exerciseName}</strong> — {describeRecord(pr)}
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
                      const label = setLabel(set);
                      const skipped = set.isAutofilled || (!label && !set.isExtra);
                      return (
                        <span key={set.setNumber} className="tracker-summary__set">
                          <span className="tracker-summary__set-num">{set.setNumber}</span>
                          {skipped || !label ? <em>skipped</em> : label}
                        </span>
                      );
                    })
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="tracker-summary__footer">
          <button className="tracker-summary__done" style={{ background: accentColor }} onClick={onDone}>
            Back to calendar
          </button>
        </div>
      </div>
    </div>
  );
}
