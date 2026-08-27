import { useState } from 'react';
import { Timer, Trophy } from 'lucide-react';
import { formatElapsed } from '../../lib/time';
import { parseDurationSeconds, type SessionScore } from '../../lib/tracking/records';
import type { ScoringType } from '../../types/workout';

interface Props {
  scoringType: Exclude<ScoringType, 'strength'>;
  /** AMRAP: the planned working window, shown for context. */
  timeCapMinutes?: number;
  /** For Time: prefill from the session's elapsed clock. */
  elapsedSeconds: number;
  accentColor: string;
  disabled?: boolean;
  /** null = finish without a score (no workout PR for this session). */
  onSubmit: (score: SessionScore | null) => void;
}

/**
 * The score step of Finish on a scored workout. For Time asks for the
 * completion time (prefilled from the timer, editable — the clock ran from
 * Start, not from 3-2-1-go); AMRAP asks rounds + extra reps.
 */
export default function ScorePrompt({
  scoringType, timeCapMinutes, elapsedSeconds, accentColor, disabled, onSubmit,
}: Props) {
  const [time, setTime] = useState(() => formatElapsed(elapsedSeconds));
  const [rounds, setRounds] = useState('');
  const [reps, setReps] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (scoringType === 'for-time') {
      const seconds = parseDurationSeconds(time);
      if (seconds === null || seconds <= 0) {
        setProblem('Enter the time as mm:ss');
        return;
      }
      onSubmit({ type: 'for-time', timeSeconds: Math.round(seconds) });
      return;
    }
    const r = parseInt(rounds, 10);
    if (!Number.isFinite(r) || r < 0) {
      setProblem('Enter completed rounds');
      return;
    }
    const extra = reps.trim() === '' ? 0 : parseInt(reps, 10);
    if (!Number.isFinite(extra) || extra < 0) {
      setProblem('Extra reps must be a number');
      return;
    }
    onSubmit({ type: 'amrap', rounds: r, reps: extra });
  };

  return (
    <div className="tracker-confirm tracker-score">
      <span className="tracker-score__msg">
        <Trophy size={14} strokeWidth={2} style={{ color: accentColor }} />
        {scoringType === 'for-time'
          ? 'Your time — this is what the PR is measured on.'
          : `Rounds + extra reps inside the ${timeCapMinutes ? `${timeCapMinutes} min ` : ''}cap.`}
      </span>
      <div className="tracker-score__inputs">
        {scoringType === 'for-time' ? (
          <label className="tracker-score__field">
            <Timer size={14} strokeWidth={1.5} />
            <input
              className="tracker-score__input"
              inputMode="numeric"
              aria-label="Completion time"
              value={time}
              onChange={e => { setTime(e.target.value); setProblem(null); }}
            />
          </label>
        ) : (
          <>
            <label className="tracker-score__field">
              <input
                className="tracker-score__input"
                inputMode="numeric"
                aria-label="Rounds completed"
                placeholder="rounds"
                value={rounds}
                onChange={e => { setRounds(e.target.value); setProblem(null); }}
                autoFocus
              />
            </label>
            <span className="tracker-score__plus">+</span>
            <label className="tracker-score__field">
              <input
                className="tracker-score__input"
                inputMode="numeric"
                aria-label="Extra reps"
                placeholder="reps"
                value={reps}
                onChange={e => { setReps(e.target.value); setProblem(null); }}
              />
            </label>
          </>
        )}
      </div>
      {problem && <span className="tracker-score__problem">{problem}</span>}
      <button className="tracker-confirm__cancel" onClick={() => onSubmit(null)} disabled={disabled}>
        Skip score
      </button>
      <button
        className="tracker-confirm__go"
        style={{ background: accentColor }}
        onClick={submit}
        disabled={disabled}
      >
        Save score
      </button>
    </div>
  );
}
