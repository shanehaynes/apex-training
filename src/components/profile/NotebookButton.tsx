import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCalendar } from '../../context/calendar';
import { listCoachMemories, listCoachReflections } from '../../lib/api';
import { readReflections, splitMemories, splitReflections } from '../../lib/coach/notebook';
import type { CoachMemory } from '../../lib/coach/memory';
import './notebook-button.css';

// The profile's way into the coach notebook, with a count of what is waiting
// there for the athlete: the reflections nobody has accepted or rejected and
// the memories nobody has confirmed — the same two tests the notebook uses to
// put a card on top with Accept on it (splitReflections().pending,
// splitMemories().proposals). Without it, an overnight reflection lands silently.
//
// The count is read on mount and again each time the notebook closes (the
// profile stays mounted underneath it), so a proposal resolved inside the
// notebook is gone from the badge on return. The notebook's Accept is
// optimistic — its POST may still be in flight when the athlete closes — so a
// close reads once more after REREAD_AFTER_CLOSE_MS. While loading, on any failure,
// and at zero, there is no badge — a wrong number is worse than none.

/** What the notebook would show with Accept on it: its own pending reflections plus its own memory proposals. */
export function pendingProposalCount(reflectionsPayload: unknown, memoriesPayload: unknown): number {
  const reflections = readReflections(reflectionsPayload) ?? [];
  const memories = isRecord(memoriesPayload) && Array.isArray(memoriesPayload.memories)
    ? (memoriesPayload.memories.filter(isRecord) as unknown as CoachMemory[])
    : [];
  return splitReflections(reflections).pending.length + splitMemories(memories).proposals.length;
}

/** The second read after a close, for an Accept whose POST had not committed when the first one ran. */
export const REREAD_AFTER_CLOSE_MS = 1500;

/** `icon` is the profile's NotebookPen, passed in so ProfileView's lucide import keeps its user. */
export default function NotebookButton({ icon }: { icon: ReactNode }) {
  const { state, dispatch } = useCalendar();
  const notebookOpen = state.notebookOpen;
  const [count, setCount] = useState<number | null>(null);

  const wasOpen = useRef(false);

  useEffect(() => {
    if (notebookOpen) {
      wasOpen.current = true;
      return;
    }
    const closed = wasOpen.current;
    wasOpen.current = false;
    let cancelled = false;
    const read = () => {
      Promise.all([listCoachReflections(), listCoachMemories()])
        .then(([reflections, memories]) => {
          if (!cancelled) setCount(pendingProposalCount(reflections, memories));
        })
        .catch(() => {
          if (!cancelled) setCount(null);
        });
    };
    read();
    const timer = closed ? setTimeout(read, REREAD_AFTER_CLOSE_MS) : undefined;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [notebookOpen]);

  return <NotebookButtonView icon={icon} count={count} onOpen={() => dispatch({ type: 'OPEN_NOTEBOOK' })} />;
}

/** The button itself; `count` null means unknown (loading or failed). Exported for the markup tests. */
export function NotebookButtonView({
  icon, count, onOpen,
}: { icon?: ReactNode; count: number | null; onOpen: () => void }) {
  const label = count === 1 ? '1 proposal to review' : `${count} proposals to review`;
  return (
    <button
      type="button"
      className="btn-today notebook-button"
      data-testid="open-notebook"
      onClick={onOpen}
    >
      {icon} Open the notebook
      {count !== null && count > 0 && (
        <span className="notebook-button__badge" role="img" aria-label={label} data-testid="notebook-badge">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
