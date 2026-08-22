import { useCallback, useRef } from 'react';
import { format } from 'date-fns';
import { useBlocks } from '../context/blocks';
import { useSchedule } from '../context/schedule';
import { computeBlockProgress } from '../lib/blocks/progress';
import { loadBlockLogs } from '../lib/blocks/repo';
import { blockCovering, blockPeriod } from '../lib/blocks/period';
import { buildBlockPromptSummary } from '../lib/blocks/promptSummary';
import type { BlockPromptSummary } from '../lib/blocks/promptSummary';
import { now } from '../lib/clock';

/**
 * Resolves the active block's attainment, shaped for the coach prompt, or
 * null when no block covers today.
 *
 * Deliberately a getter rather than effect-driven state. The system prompt is
 * only ever read inside event handlers (send, confirm, cancel, briefing), so
 * building it lazily removes an ordering hazard by construction: state-backed
 * state would be null for the first moment after mount, and a message sent in
 * that window would silently reach the model with no block context — looking
 * to the user exactly like a coach that had forgotten their training plan.
 *
 * Two things are awaited rather than read from React state, which only
 * settles a render later than the data it reflects: the blocks list
 * (`whenLoaded`) and the block's logs.
 *
 * Recomputed per call on purpose. A user who logs a workout and immediately
 * asks the coach about it should get numbers that include it; the fetch is a
 * single round-trip over one block's date window.
 */
export function useBlockSummary(): () => Promise<BlockPromptSummary | null> {
  const { whenLoaded } = useBlocks();
  const { events } = useSchedule();

  // Read through a ref: the returned callback is stable, but runs long after
  // the render that created it, so it must not close over a stale schedule.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  return useCallback(async () => {
    try {
      const { blocks, objectives } = await whenLoaded();
      const block = blockCovering(blocks, format(now(), 'yyyy-MM-dd'));
      if (!block) return null;

      const period = blockPeriod(block);
      const logs = await loadBlockLogs(block);
      const progress = computeBlockProgress(
        {
          period,
          ...logs,
          block,
          // Expanded occurrences inside the window: the source of the
          // calendar-derived fallback for any target left unauthored.
          plannedEvents: eventsRef.current.filter(
            e => e.date >= period.startDate && e.date < period.endDateExclusive,
          ),
        },
        now(),
      );
      return buildBlockPromptSummary(progress, objectives.find(o => o.id === block.objectiveId) ?? null);
    } catch (err) {
      // Block context is an enhancement, never a precondition for chatting.
      // Degrade to a prompt without it rather than blocking the send.
      console.warn('[apex] Block summary unavailable for the coach prompt:', err);
      return null;
    }
  }, [whenLoaded]);
}
