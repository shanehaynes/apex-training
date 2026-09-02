import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { now } from '../lib/clock';
import { useAuth } from '../context/auth';
import { useBlocks } from '../context/blocks';
import { blockPeriod } from '../lib/blocks/period';
import type { ChartSpec } from '../lib/analytics/spec';
import { needsHrZones } from '../lib/analytics/spec';
import { unionWindow } from '../lib/analytics/window';
import { EMPTY_INPUTS, loadAnalyticsInputs } from '../lib/analytics/fetch';
import type { AnalyticsInputs, ComputeContext } from '../lib/analytics/engine';

// Window-bounded chart data for a set of specs. Each consumer (the dashboard
// grid, the tile builder's live preview) owns one instance: the hook fetches
// the union window of its specs and refetches only when that window grows
// beyond what it already holds (or the HR-zone requirement appears). Debounced
// so builder keystrokes on a date field don't fire a fetch per character.

export interface AnalyticsData {
  inputs: AnalyticsInputs;
  ctx: ComputeContext;
  loading: boolean;
}

interface Covered {
  startDate: string;
  endDateExclusive: string;
  withZones: boolean;
}

export function useAnalyticsData(specs: ChartSpec[]): AnalyticsData {
  const { profile } = useAuth();
  const { activeBlock } = useBlocks();

  const [inputs, setInputs] = useState<AnalyticsInputs>(EMPTY_INPUTS);
  const [loading, setLoading] = useState(false);
  const coveredRef = useRef<Covered | null>(null);

  const todayIso = format(now(), 'yyyy-MM-dd');
  const activePeriod = useMemo(
    () => (activeBlock ? blockPeriod(activeBlock) : null),
    [activeBlock],
  );

  const maxHr = profile?.max_hr ?? null;
  const thresholdHr = profile?.threshold_hr ?? null;

  const window = useMemo(
    () => unionWindow(specs, todayIso, activePeriod),
    [specs, todayIso, activePeriod],
  );
  const withZones = needsHrZones(specs);

  // Serialized dependency: the specs array is rebuilt every render, but a
  // fetch should only fire when the *window* or zone requirement changes.
  const windowKey = window ? `${window.startDate}|${window.endDateExclusive}|${withZones}` : 'none';

  useEffect(() => {
    if (!window) return;
    const covered = coveredRef.current;
    const alreadyCovered =
      covered &&
      covered.startDate <= window.startDate &&
      covered.endDateExclusive >= window.endDateExclusive &&
      (covered.withZones || !withZones);
    if (alreadyCovered) return;

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      // Fetch the union of old and new coverage so a shrinking window never
      // discards data another tile still renders from.
      const target = covered
        ? {
            startDate: covered.startDate < window.startDate ? covered.startDate : window.startDate,
            endDateExclusive: covered.endDateExclusive > window.endDateExclusive ? covered.endDateExclusive : window.endDateExclusive,
          }
        : window;
      const zones = withZones || covered?.withZones === true;
      const next = await loadAnalyticsInputs(target, { withHrZones: zones, hr: { maxHr, thresholdHr } });
      if (cancelled) return;
      coveredRef.current = { ...target, withZones: zones };
      setInputs(next);
      setLoading(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [windowKey, maxHr, thresholdHr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zone seconds are reduced at fetch with the bounds current at that time;
  // an HR-settings change invalidates them.
  useEffect(() => {
    coveredRef.current = null;
  }, [maxHr, thresholdHr]);

  const ctx = useMemo<ComputeContext>(
    () => ({ todayIso, activeBlock: activePeriod, hr: { maxHr, thresholdHr } }),
    [todayIso, activePeriod, maxHr, thresholdHr],
  );

  return { inputs, ctx, loading };
}
