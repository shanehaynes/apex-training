// Digit-buffer model for the stopwatch-style duration input: digits fill
// right-to-left (typing 2,3,0 reads 0:02 → 0:23 → 2:30), so a bare keystroke
// is never ambiguous — the display always shows the duration that will be
// stored. The buffer is a plain digit string with no leading zeros.

export const MAX_DIGITS = 6;

// A value the stopwatch control can represent: empty, or a single clean
// duration token ("2", "90s", "1:30", "2 min"). Anything else — "10s on 5s
// off", "each side", "to failure" — stays free text so the field never
// silently drops what the user typed.
export const PLAIN_DURATION =
  /^(\d+:\d{1,2}(:\d{1,2})?|\d+(\.\d+)?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?)$/i;

export const isPlain = (v: string) => v.trim() === '' || PLAIN_DURATION.test(v.trim());

/** Right-split the buffer into h/mm/ss groups: last two digits are seconds,
 * next two minutes, the rest hours. "0:90" is a legal buffer state — overflow
 * only rolls up on commit, via seconds math. */
export function digitsToSeconds(digits: string): number {
  const sec = Number(digits.slice(-2) || '0');
  const rest = digits.slice(0, -2);
  const min = Number(rest.slice(-2) || '0');
  const hrs = Number(rest.slice(0, -2) || '0');
  return hrs * 3600 + min * 60 + sec;
}

/** Literal group display while typing: '2' → "0:02", '90' → "0:90",
 * '230' → "2:30", '12345' → "1:23:45". Empty buffer shows nothing so the
 * placeholder stays visible. */
export function digitsToDisplay(digits: string): string {
  if (digits === '') return '';
  const sec = digits.slice(-2).padStart(2, '0');
  const rest = digits.slice(0, -2);
  const min = rest.slice(-2) || '0';
  const hrs = rest.slice(0, -2);
  return hrs ? `${hrs}:${min.padStart(2, '0')}:${sec}` : `${min}:${sec}`;
}
