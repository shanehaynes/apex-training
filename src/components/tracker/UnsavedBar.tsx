import { RefreshCw } from 'lucide-react';
import type { SaveQueueState } from '../../lib/tracking/saveQueue';
import '../../styles/tracker-unsaved.css';

interface Props {
  state: SaveQueueState;
  onRetry: () => void;
}

/**
 * The persistent strip under the tracker header while autosave is not
 * landing. Two situations, both or either: a failure streak (the queue
 * keeps retrying on its own; Retry sends now) and refused edits (the server
 * said no — editing the field again re-queues it, so there is nothing to
 * retry). It stays until a save lands: the edits are still on screen and
 * still dirty, which is the whole point.
 */
export default function UnsavedBar({ state, onRetry }: Props) {
  const failing = state.consecutiveFailures > 0;
  const refused = state.rejected > 0;
  const retrying = state.inFlight;
  return (
    <div className="tracker-unsaved" role="status">
      <span className="tracker-unsaved__msg">
        {failing && (
          <span>
            Unsaved changes
            {state.pending > 0 && <span className="tracker-unsaved__count"> · {state.pending}</span>}
          </span>
        )}
        {failing && refused && <span className="tracker-unsaved__sep"> · </span>}
        {refused && (
          <span>
            {state.rejected} {state.rejected === 1 ? 'edit was' : 'edits were'} refused
            <span className="tracker-unsaved__count"> — edit again to resend</span>
          </span>
        )}
      </span>
      {failing && (
        // aria-busy, not disabled: a disabled button drops keyboard focus
        // mid-retry, and the user who pressed it is the one waiting on it.
        <button
          className="tracker-unsaved__retry"
          onClick={() => { if (!retrying) onRetry(); }}
          aria-busy={retrying || undefined}
          aria-disabled={retrying || undefined}
        >
          <RefreshCw size={13} strokeWidth={2} className={retrying ? 'tracker-unsaved__spin' : undefined} />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
