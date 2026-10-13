import { RefreshCw } from 'lucide-react';
import type { SaveQueueState } from '../../lib/tracking/saveQueue';
import '../../styles/tracker-unsaved.css';

interface Props {
  state: SaveQueueState;
  onRetry: () => void;
}

/**
 * The persistent strip under the tracker header while autosave is failing:
 * the queue keeps retrying on its own, and Retry sends now. It stays until a
 * save lands — the edits are still on screen and still dirty, which is the
 * whole point.
 */
export default function UnsavedBar({ state, onRetry }: Props) {
  const retrying = state.inFlight;
  return (
    <div className="tracker-unsaved" role="status">
      <span className="tracker-unsaved__msg">
        Unsaved changes
        {state.pending > 0 && (
          <span className="tracker-unsaved__count"> · {state.pending} {state.pending === 1 ? 'edit' : 'edits'}</span>
        )}
      </span>
      <button className="tracker-unsaved__retry" onClick={onRetry} disabled={retrying}>
        <RefreshCw size={13} strokeWidth={2} className={retrying ? 'tracker-unsaved__spin' : undefined} />
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
