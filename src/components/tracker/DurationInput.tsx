import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatSeconds } from '../../lib/time';
import { digitsToDisplay, digitsToSeconds, isPlain, MAX_DIGITS } from '../../lib/durationBuffer';

interface Props {
  value: string;
  ariaLabel: string;
  className: string;
  onChange: (value: string) => void;
}

/**
 * Stopwatch-style duration entry: one field, digits fill right-to-left like a
 * microwave (2,3,0 reads 0:02 → 0:23 → 2:30), so a single tap enters the whole
 * duration and the display disambiguates minutes vs seconds live. Commits the
 * canonical formatSeconds form ("45s", "2:30") the rest of the app already
 * reads. Typing any non-digit drops the field to free text for interval-style
 * entries ("10s on 5s off"); clearing it returns to digit entry.
 */
export default function DurationInput({ value, ariaLabel, className, onChange }: Props) {
  const [mode, setMode] = useState<'stopwatch' | 'text'>(() => (isPlain(value) ? 'stopwatch' : 'text'));
  // null = not editing (display derives from the value prop); string = the
  // active digit buffer while focused.
  const [buffer, setBuffer] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-derive the mode when the value changes from outside (fill-from-last,
  // reset) but not in response to our own emits or mid-edit — a text-mode
  // intermediate like "10" is coincidentally plain and must not bounce modes.
  const lastEmit = useRef(value);
  useEffect(() => {
    if (value === lastEmit.current || buffer !== null) return;
    lastEmit.current = value;
    setMode(isPlain(value) ? 'stopwatch' : 'text');
  }, [value, buffer]);

  const emit = (out: string) => {
    lastEmit.current = out;
    onChange(out);
  };

  const stopwatch = mode === 'stopwatch';
  const display = stopwatch ? (buffer === null ? value : digitsToDisplay(buffer)) : value;

  // Keep the caret at the right edge while filling, matching the direction
  // digits move; makes caret position semantically irrelevant.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (stopwatch && buffer !== null && el && document.activeElement === el) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [stopwatch, buffer]);

  const switchToText = (raw: string) => {
    // Reconstruct what the user typed: the display is our formatting ("0:10"),
    // so replace it with the raw buffer digits before the new character —
    // typing 1,0,s yields "10s", not "0:10s". A lone trailing "." is the
    // mobile escape hatch into text mode (the decimal keypad has no letters)
    // and is dropped from the seed.
    const shown = digitsToDisplay(buffer ?? '');
    const seed = (raw.startsWith(shown) ? (buffer ?? '') + raw.slice(shown.length) : raw).replace(/\.+$/, '');
    setMode('text');
    setBuffer(null);
    emit(seed);
    // iOS only swaps the soft keyboard (decimal → text) on refocus.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el && document.activeElement === el) {
        el.blur();
        el.focus();
      }
    });
  };

  const changeStopwatch = (raw: string) => {
    if (/[^0-9:]/.test(raw)) {
      switchToText(raw);
      return;
    }
    const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length > MAX_DIGITS) return;
    setBuffer(digits);
    emit(digits === '' ? '' : formatSeconds(digitsToSeconds(digits)));
  };

  const changeText = (raw: string) => {
    if (raw === '') {
      emit('');
      setMode('stopwatch');
      setBuffer(inputRef.current && document.activeElement === inputRef.current ? '' : null);
      return;
    }
    emit(raw);
  };

  return (
    <input
      ref={inputRef}
      className={`${className} tracker-duration`}
      type="text"
      inputMode={stopwatch ? 'decimal' : 'text'}
      aria-label={ariaLabel}
      placeholder={stopwatch ? value || '0:00' : ''}
      value={display}
      onChange={e => (stopwatch ? changeStopwatch(e.target.value) : changeText(e.target.value))}
      onFocus={stopwatch ? () => setBuffer('') : undefined}
      onBlur={stopwatch ? () => setBuffer(null) : undefined}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (stopwatch && buffer === '' && value !== '' && (e.key === 'Backspace' || e.key === 'Delete')) {
          // Clear a stored value without having to type a throwaway digit.
          emit('');
        }
      }}
    />
  );
}
