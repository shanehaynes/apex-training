import { createContext, useContext } from 'react';
import { format } from 'date-fns';
import { buildMonthGrid } from '../utils/dateHelpers';
import type { CoachAnnotation } from '../lib/coach/annotations';

// Context object + hook live apart from the provider so AnnotationsContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

export interface AnnotationRange {
  /** Inclusive YYYY-MM-DD bounds of the calendar grid being shown. */
  from: string;
  to: string;
}

/**
 * The range the provider fetches for a calendar date: the month grid that
 * contains it — Monday of the week holding the 1st through Sunday of the
 * week holding the last day. Every view fits inside it (the week view's
 * seven days and the day view's one are cells of that grid), so a view
 * switch never refetches and a month step fetches exactly once.
 */
export function visibleAnnotationRange(date: Date): AnnotationRange {
  const weeks = buildMonthGrid(date);
  const first = weeks[0][0];
  const last = weeks[weeks.length - 1][6];
  return { from: format(first, 'yyyy-MM-dd'), to: format(last, 'yyyy-MM-dd') };
}

export interface AnnotationsContextValue {
  /** Every live note loaded for the current range (days) plus all live
   *  event and block notes, in reading order. */
  annotations: CoachAnnotation[];
  /** The range the current `annotations` were fetched for. */
  range: AnnotationRange;
  /** Live notes on a 'YYYY-MM-DD' day, most severe first. */
  byDay: (date: string) => CoachAnnotation[];
  /** Live notes on an event occurrence id (`base__date` for a recurring instance). */
  byEvent: (id: string) => CoachAnnotation[];
  /** Live notes on a training block uuid. */
  byBlock: (id: string) => CoachAnnotation[];
  /** Optimistic: the chip is gone before the server answers, and comes back
   *  (with a toast from the API layer) if the dismiss fails. */
  dismiss: (id: string) => Promise<void>;
  /** Re-fetch the current range — what a writer calls after leaving a note. */
  refresh: () => Promise<void>;
}

export const AnnotationsContext = createContext<AnnotationsContextValue | null>(null);

export function useAnnotations(): AnnotationsContextValue {
  const ctx = useContext(AnnotationsContext);
  if (!ctx) throw new Error('useAnnotations must be used within an AnnotationsProvider');
  return ctx;
}
