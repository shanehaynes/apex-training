import { useEffect, useState } from 'react';
import '../../styles/quarter-pr.css';

/** How long each field stays readable, and each fade out or in. */
export const DWELL_MS = 4000;
export const FADE_MS = 500;

/** Where the line is: which field, and whether it is showing or faded out. */
export interface TickerState {
  index: number;
  shown: boolean;
}

/** How long the line stays in `state` before tickerAdvance moves it on. */
export function tickerDelay(state: TickerState): number {
  return state.shown ? DWELL_MS : FADE_MS;
}

/** A showing field fades out; a faded one gives way to the next field, fading in. */
export function tickerAdvance(state: TickerState, count: number): TickerState {
  return state.shown
    ? { index: state.index, shown: false }
    : { index: (state.index + 1) % count, shown: true };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/**
 * The quarterly best in a set row's target column, one field at a time:
 * each shows for DWELL_MS, fades out and the next fades in. One field
 * shows still. With reduced motion asked for, nothing moves: the whole set
 * shows on one line (`summary`). Screen readers get `description` once,
 * never the cycling text.
 */
export default function QuarterPrTicker({ fields, summary, description }: {
  fields: string[];
  summary: string;
  description: string;
}) {
  const reduced = useReducedMotion();
  const cycling = !reduced && fields.length > 1;
  const [state, setState] = useState<TickerState>({ index: 0, shown: true });
  const count = fields.length;

  useEffect(() => {
    if (!cycling) return;
    const timer = setTimeout(() => setState(s => tickerAdvance(s, count)), tickerDelay(state));
    return () => clearTimeout(timer);
  }, [cycling, state, count]);

  const { index, shown } = state;

  const text = cycling ? fields[index % fields.length] : reduced ? summary : fields[0] ?? summary;
  return (
    <span className="quarter-pr__cell" title={description}>
      <span className="quarter-pr__sr">{description}</span>
      <span
        className={`quarter-pr__value${cycling && !shown ? ' quarter-pr__value--hidden' : ''}`}
        aria-hidden="true"
        data-testid="quarter-pr-value"
      >
        {text}
      </span>
    </span>
  );
}
