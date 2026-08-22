import { useEffect } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';
import { useProviderSync, type SyncProposal } from '../../hooks/useProviderSync';
import { useCalendar } from '../../context/calendar';
import { notify } from '../../lib/notify';

// The COROS toolbar button + the per-fill confirmation queue card. Mounted
// once in TopNav; also owns the ?connected=coros / ?connect_error=coros
// params the OAuth callback bounces back with, since TopNav is always
// mounted when the redirect lands.

function fillPrompt(proposal: SyncProposal): string {
  const { activity, match } = proposal;
  const facts = [activity.sportLabel, activity.displayTime, activity.distance ?? `${activity.durationMin} min`]
    .filter(Boolean)
    .join(' · ');
  return `${facts} — fill planned “${match?.title}”?`;
}

export default function ProviderSyncControls() {
  const {
    status, configured, isSyncing, pendingFills, pendingFillCount,
    refreshStatus, runSync, confirmFill,
  } = useProviderSync();
  const { dispatch } = useCalendar();

  // OAuth callback return: toast the outcome, clean the URL, re-check status.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const failed = params.get('connect_error');
    if (!connected && !failed) return;
    if (connected === 'coros') notify('COROS connected — press Sync to grab activities');
    if (failed === 'coros') notify('COROS connection failed — try again from Profile');
    params.delete('connected');
    params.delete('connect_error');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    refreshStatus();
  }, [refreshStatus]);

  if (!configured || status === 'disconnected' || status === 'unknown' || status === 'pending') {
    return null;
  }

  const head = pendingFills[0];

  return (
    <>
      <button
        className="btn-library"
        data-testid="nav-coros-sync"
        onClick={() => (status === 'expired' ? dispatch({ type: 'OPEN_PROFILE' }) : runSync())}
        disabled={isSyncing}
        title={status === 'expired' ? 'COROS connection expired — reconnect' : 'Sync activities from COROS'}
      >
        <RefreshCw size={14} strokeWidth={1.5} className={isSyncing ? 'sync-spin' : undefined} />
        <span className="btn-library__label">{status === 'expired' ? 'Reconnect' : 'Sync'}</span>
        {pendingFillCount > 0 && pendingFills.length === 0 && (
          <span className="sync-pending-badge" title={`${pendingFillCount} matched ${pendingFillCount === 1 ? 'activity' : 'activities'} waiting for your confirmation`}>
            {pendingFillCount}
          </span>
        )}
      </button>

      {head && (
        <div className="sync-confirm chat-confirm-card" data-testid="sync-confirm-card">
          <p className="chat-confirm-card__label">
            {fillPrompt(head)}
            {pendingFills.length > 1 && (
              <span className="chat-confirm-card__queue"> · {pendingFills.length - 1} more after this</span>
            )}
          </p>
          <div className="chat-confirm-card__actions">
            <button
              className="chat-confirm-card__btn chat-confirm-card__btn--cancel"
              onClick={() => confirmFill(false)}
            >
              <X size={12} /> Keep separate
            </button>
            <button
              className="chat-confirm-card__btn chat-confirm-card__btn--confirm"
              onClick={() => confirmFill(true)}
            >
              <Check size={12} /> Fill it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
