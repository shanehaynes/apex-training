import '../../styles/rest-timer.css';

interface Props {
  /** Whole seconds left. */
  remaining: number;
  /** 0 at the start of the round, 1 at its end — the thinning line. */
  progress: number;
  /** The exercise the rest belongs to. */
  label: string;
  onExtend: () => void;
  onSkip: () => void;
}

/** "1:28", "0:05" — minutes unpadded, like the prescription reads. */
function formatRest(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The rest countdown between sets: "Rest 1:28 · +15 s · Skip". Sits under
 * the header (below the Unsaved bar), in flow, so it never collides with the
 * confirm and score bars pinned to the bottom and stays on screen while the
 * phone keyboard is up — the set was just typed, so the keyboard is.
 */
export default function RestTimerBar({ remaining, progress, label, onExtend, onSkip }: Props) {
  const time = formatRest(remaining);
  return (
    <div className="rest-timer" data-testid="rest-timer">
      <div className="rest-timer__row">
        <span className="rest-timer__label">
          Rest
          {label && <span className="rest-timer__name"> · {label}</span>}
        </span>
        <span className="rest-timer__time" role="timer" aria-live="off" aria-label={`Rest, ${remaining} seconds left`}>
          {time}
        </span>
        <button type="button" className="rest-timer__btn" onClick={onExtend} aria-label="Add fifteen seconds of rest">
          +15 s
        </button>
        <button type="button" className="rest-timer__btn" onClick={onSkip} aria-label="Skip the rest">
          Skip
        </button>
      </div>
      <div className="rest-timer__track" aria-hidden="true">
        <div className="rest-timer__fill" style={{ width: `${Math.round((1 - progress) * 1000) / 10}%` }} />
      </div>
    </div>
  );
}
