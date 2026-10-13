import { useMemo, useState } from 'react';
import { CopyPlus } from 'lucide-react';
import { useSchedule } from '../../context/schedule';
import { postJson } from '../../lib/api';
import { notify } from '../../lib/notify';
import { isPastDay } from '../../lib/clock';
import { addIsoDays, eventsInWeek, planWeekCopy, runCopies, weekCopySummary, weekStartIso } from '../../lib/calendar/copy';
import type { CalendarView } from '../../types/workout';
import '../../styles/copy.css';

/**
 * "Copy last week": shown only while the viewed Monday–Sunday week has no
 * events at all (one-offs and occurrences alike), in the views that show a
 * week — the week grid and the day view's week strip; the month view has
 * no "viewed week". Copies the previous week's one-offs forward by seven
 * days through POST /api/events (never the draft door, which would
 * retro-log anything past-dated), one insert at a time, and says exactly
 * what landed. Series occurrences stay on their series and are counted.
 */
export default function CopyWeek({ currentDate, view }: { currentDate: Date; view: CalendarView }) {
  const { events, isEventsLoading, refreshEvents } = useSchedule();
  const [busy, setBusy] = useState(false);

  const weekStart = weekStartIso(currentDate);
  const weekEmpty = useMemo(() => eventsInWeek(events, weekStart).length === 0, [events, weekStart]);
  // Ids are minted per render of an empty week; a click posts this plan.
  const plan = useMemo(
    () => (weekEmpty ? planWeekCopy(events, currentDate) : null),
    [events, currentDate, weekEmpty],
  );

  if (view === 'month' || isEventsLoading || !weekEmpty || !plan) return null;

  const copy = async () => {
    setBusy(true);
    // Quiet: the summary below is the one message, not a toast per failure.
    const result = await runCopies(plan.copies, body => postJson('/api/events', body, 'Copying workout', { quiet: true }));
    notify(weekCopySummary(result, plan.skipped));
    if (result.landed.length > 0) refreshEvents().catch(() => {});
    setBusy(false);
  };

  const count = plan.copies.length;
  const skippedNote = plan.skipped > 0
    ? ` ${plan.skipped} repeating ${plan.skipped === 1 ? 'one stays' : 'ones stay'} on ${plan.skipped === 1 ? 'its' : 'their'} series.`
    : '';
  // A copy is a plan, never a log — but a past week fills with workouts
  // that read as missed, so say so before the click.
  const pastNote = isPastDay(addIsoDays(weekStart, 6)) ? ' This week is in the past: copies are planned, not logged.' : '';

  return (
    <div className="copy-week" data-testid="copy-week">
      {count === 0 ? (
        <p className="copy-week__text" data-testid="copy-week-empty">
          Nothing to copy from last week.{skippedNote}
        </p>
      ) : (
        <>
          <p className="copy-week__text">
            This week is empty.{skippedNote}{pastNote}
          </p>
          <button
            className="copy-week__btn"
            data-testid="copy-week-btn"
            onClick={copy}
            disabled={busy}
            title="Copy last week's one-off workouts onto the same weekdays here — delete a copy to undo"
          >
            <CopyPlus size={14} strokeWidth={1.5} />
            {busy ? 'Copying…' : `Copy last week (${count})`}
          </button>
        </>
      )}
    </div>
  );
}
