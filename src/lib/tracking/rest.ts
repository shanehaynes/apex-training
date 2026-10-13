/**
 * The rest prescription (`Exercise.restPeriod`) is free text. The rest timer
 * pre-fills from it only when it reads unambiguously as one duration:
 *
 *   "90s" · "90 sec" · "2 min" · "1:30" · a range "2-3 min" / "60–90s"
 *
 * A range takes its lower end with the shared unit. Anything else — "as
 * needed", "0", empty, a bare number, "90 sec/side" — is no timer at all:
 * a wrong countdown is worse than none. Strict on purpose, and separate from
 * `parseDurationSeconds` (records.ts), which reads a leading duration out of
 * free text and so turns "2-3 min" into two seconds.
 */

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const SECONDS = String.raw`(?:s|secs?|seconds?)`;
const MINUTES = String.raw`(?:mins?|minutes?)`;
const UNIT = `(${SECONDS}|${MINUTES})`;

const SINGLE = new RegExp(`^${NUMBER}\\s*${UNIT}$`);
const RANGE = new RegExp(`^${NUMBER}\\s*[-–]\\s*${NUMBER}\\s*${UNIT}$`);
const CLOCK = /^(\d+):([0-5]\d)$/;

function toSeconds(n: string, unit: string): number | null {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return null;
  const seconds = Math.round(/^m/.test(unit) ? value * 60 : value);
  return seconds > 0 ? seconds : null;
}

/** Whole seconds for the rest text, or null when no timer should start. */
export function parseRestSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const v = text.trim().toLowerCase();
  if (!v) return null;

  const clock = v.match(CLOCK);
  if (clock) {
    const seconds = Number(clock[1]) * 60 + Number(clock[2]);
    return seconds > 0 ? seconds : null;
  }

  const range = v.match(RANGE);
  if (range) {
    const low = toSeconds(range[1], range[3]);
    const high = toSeconds(range[2], range[3]);
    // "90-60s" is not a range anyone meant.
    return low !== null && high !== null && high >= low ? low : null;
  }

  const single = v.match(SINGLE);
  if (single) return toSeconds(single[1], single[2]);

  return null;
}
