import { useState } from 'react';
import { Clock } from 'lucide-react';
import { format, isSameDay } from 'date-fns';
import { formatRunawayLength, type RunawayFinish } from '../../lib/tracking/runawayFinish';
import '../../styles/tracker-finish-time.css';

// <input type="datetime-local"> speaks local wall-clock time, to the minute.
const INPUT_DATETIME = "yyyy-MM-dd'T'HH:mm";
const MINUTE_MS = 60_000;

interface Props {
  runaway: RunawayFinish;
  /** The session's started_at, ISO. */
  startedAt: string;
  /** The tracker's live clock, so the labels and "now" keep up while the prompt is open. */
  elapsedSeconds: number;
  accentColor: string;
  disabled?: boolean;
  /** Finish at this instant (ISO). */
  onFinishAt: (iso: string) => void;
  /** "It ran this long": finish now, as Finish always has. */
  onAsRecorded: () => void;
  /** Close the prompt; nothing is recorded. */
  onKeep: () => void;
}

/**
 * The Finish step for a session that ran far past its plan
 * (docs/specs/tracker-runaway-finish): when did it really end? Prefilled with
 * the last logged set (or the start plus the plan); the athlete's number
 * wins either way, and "It ran …" is the same one tap as accepting the
 * default.
 */
export default function FinishTimePrompt({
  runaway, startedAt, elapsedSeconds, accentColor, disabled, onFinishAt, onAsRecorded, onKeep,
}: Props) {
  const startedMs = Date.parse(startedAt);
  const suggestedMs = runaway.suggestion.atMs;
  const [draft, setDraft] = useState(() => format(new Date(suggestedMs), INPUT_DATETIME));
  const [touched, setTouched] = useState(false);
  // "Now" moves with the tracker's clock (it ticks each second), never
  // earlier than the moment the prompt opened.
  const [openedAtMs] = useState(() => Date.now());
  const nowMs = Math.max(openedAtMs, startedMs + elapsedSeconds * 1000);
  const ranFor = formatRunawayLength(Math.max(runaway.elapsedSeconds, elapsedSeconds));

  // Untouched, the suggestion goes as it is, to the millisecond (the field
  // shows minutes only). A time typed into the start's own minute means the
  // start; anything earlier, or later than now, cannot be the end.
  const parsed = touched ? Date.parse(draft) : suggestedMs;
  const valid = Number.isFinite(parsed) && parsed + MINUTE_MS > startedMs && parsed <= nowMs;
  const chosenMs = valid ? Math.max(parsed, startedMs) : null;

  const timeLabel = chosenMs === null
    ? null
    : format(new Date(chosenMs), isSameDay(chosenMs, nowMs) ? 'h:mm a' : 'MMM d, h:mm a');

  return (
    <div className="tracker-confirm tracker-finish-time" data-testid="finish-time" role="group" aria-label="When did this workout end?">
      <span className="tracker-finish-time__msg">
        <Clock size={14} strokeWidth={2} style={{ color: accentColor }} />
        This session has run {ranFor} against
        a {formatRunawayLength(runaway.plannedMinutes * 60)} plan. When did it end?
      </span>
      <label className="tracker-finish-time__field">
        <span>Ended</span>
        <input
          type="datetime-local"
          className="tracker-finish-time__input"
          aria-label="Ended at"
          value={draft}
          min={format(new Date(startedMs), INPUT_DATETIME)}
          max={format(new Date(nowMs), INPUT_DATETIME)}
          onChange={e => { setDraft(e.target.value); setTouched(true); }}
          disabled={disabled}
        />
      </label>
      <span className="tracker-finish-time__hint">
        {!valid
          ? 'Pick a time between the start and now.'
          : runaway.suggestion.basis === 'last-logged'
            ? 'Prefilled with when your last set was saved.'
            : 'Nothing logged yet — prefilled with the start plus the plan.'}
      </span>
      <div className="tracker-finish-time__actions">
        <button className="tracker-confirm__cancel" onClick={onKeep} disabled={disabled}>
          Keep going
        </button>
        <button className="tracker-confirm__cancel" onClick={onAsRecorded} disabled={disabled}>
          It ran {ranFor}
        </button>
        <button
          className="tracker-confirm__go"
          style={{ background: accentColor }}
          onClick={() => { if (chosenMs !== null) onFinishAt(new Date(chosenMs).toISOString()); }}
          disabled={disabled || chosenMs === null}
        >
          {timeLabel ? `Finish at ${timeLabel}` : 'Finish'}
        </button>
      </div>
    </div>
  );
}
