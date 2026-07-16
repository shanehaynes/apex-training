import { useEffect, useRef, useState } from 'react';
import { parseDurationSeconds } from '../../lib/tracking/records';
import { formatSeconds } from '../../lib/time';

interface Props {
  value: string;
  ariaLabel: string;
  className: string;
  onChange: (value: string) => void;
}

// A value the two-field control can represent: empty, or a single clean
// duration token ("2", "90s", "1:30", "2 min"). Anything else — "10s on 5s
// off", "each side", "to failure" — stays free text in custom mode so the
// field never silently drops what the user typed.
const PLAIN_DURATION =
  /^(\d+:\d{1,2}(:\d{1,2})?|\d+(\.\d+)?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?)$/i;

const isPlain = (v: string) => v.trim() === '' || PLAIN_DURATION.test(v.trim());

function toFields(value: string): { min: string; sec: string } {
  const total = parseDurationSeconds(value);
  if (total === null) return { min: '', sec: '' };
  return { min: String(Math.floor(total / 60)), sec: String(total % 60).padStart(2, '0') };
}

/**
 * Duration entry as separate minutes and seconds, so a hold logged as "2" is
 * unambiguously 2:00 — the free-text field it replaced had to guess, and
 * guessed seconds. Commits the canonical formatSeconds form ("45s", "2:00")
 * that the rest of the app already reads, so nothing downstream changes. A
 * one-tap toggle drops to a raw text field for interval-style entries the two
 * fields can't express.
 */
export default function DurationInput({ value, ariaLabel, className, onChange }: Props) {
  const initial = toFields(value);
  const [custom, setCustom] = useState(() => !isPlain(value));
  const [min, setMin] = useState(initial.min);
  const [sec, setSec] = useState(initial.sec);

  // Re-sync the fields when the value changes from outside (fill-from-last,
  // reset) but not in response to our own emits.
  const lastEmit = useRef(value);
  useEffect(() => {
    if (custom || value === lastEmit.current) return;
    const f = toFields(value);
    setMin(f.min);
    setSec(f.sec);
    setCustom(!isPlain(value));
  }, [value, custom]);

  const emit = (mRaw: string, sRaw: string) => {
    const m = mRaw.trim();
    const s = sRaw.trim();
    const out = m === '' && s === '' ? '' : formatSeconds((parseInt(m || '0', 10) || 0) * 60 + (parseInt(s || '0', 10) || 0));
    lastEmit.current = out;
    onChange(out);
  };

  if (custom) {
    return (
      <span className="tracker-duration tracker-duration--custom">
        <input
          className={className}
          type="text"
          aria-label={ariaLabel}
          value={value}
          onChange={e => onChange(e.target.value)}
        />
        <button
          type="button"
          className="tracker-duration__mode"
          aria-label="Switch to minutes and seconds"
          onClick={() => {
            const f = toFields(value);
            setMin(f.min);
            setSec(f.sec);
            lastEmit.current = value;
            setCustom(false);
          }}
        >
          m:ss
        </button>
      </span>
    );
  }

  const changeMin = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 3);
    setMin(digits);
    emit(digits, sec);
  };
  const changeSec = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    setSec(digits);
    emit(min, digits);
  };
  // On blur, roll any 60+ seconds up into minutes and pad, so 2 / 90 reads back as 3:30.
  const normalize = () => {
    if (min.trim() === '' && sec.trim() === '') return;
    const total = (parseInt(min || '0', 10) || 0) * 60 + (parseInt(sec || '0', 10) || 0);
    setMin(String(Math.floor(total / 60)));
    setSec(String(total % 60).padStart(2, '0'));
  };

  return (
    <span className="tracker-duration tracker-duration--split">
      <input
        className={`${className} tracker-duration__field`}
        type="text"
        inputMode="numeric"
        aria-label={`${ariaLabel} minutes`}
        placeholder="0"
        value={min}
        onChange={e => changeMin(e.target.value)}
        onBlur={normalize}
      />
      <span className="tracker-duration__colon" aria-hidden="true">:</span>
      <input
        className={`${className} tracker-duration__field`}
        type="text"
        inputMode="numeric"
        aria-label={`${ariaLabel} seconds`}
        placeholder="00"
        value={sec}
        onChange={e => changeSec(e.target.value)}
        onBlur={normalize}
      />
      <button
        type="button"
        className="tracker-duration__mode"
        aria-label="Switch to free text"
        onClick={() => setCustom(true)}
      >
        abc
      </button>
    </span>
  );
}
