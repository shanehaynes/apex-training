import { useState } from 'react';
import { canonicalDurationText } from '../../lib/tracking/records';

interface Props {
  value: string;
  ariaLabel: string;
  className: string;
  onChange: (value: string) => void;
}

/**
 * Duration field that accepts any of the equivalent spellings the parser
 * understands — "90", "1:30", "2 min" — and rewrites the committed value to
 * the canonical formatSeconds form on blur/Enter. While typing, a hint shows
 * the canonical equivalent live ("90" → "= 1:30") so seconds and mm:ss are
 * visibly the same value before the rewrite happens.
 */
export default function DurationInput({ value, ariaLabel, className, onChange }: Props) {
  const [focused, setFocused] = useState(false);
  const canonical = canonicalDurationText(value);
  const hint = focused && canonical !== null && canonical !== value.trim() ? `= ${canonical}` : null;

  // Text that isn't purely one duration (e.g. "10s on 5s off") is kept
  // verbatim — the field stays free-form; only plain durations canonicalize.
  const commit = () => {
    if (canonical !== null && canonical !== value) onChange(canonical);
  };

  return (
    <span className="tracker-duration">
      <input
        className={className}
        type="text"
        inputMode="text"
        aria-label={ariaLabel}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {hint && <span className="tracker-duration__hint">{hint}</span>}
    </span>
  );
}
