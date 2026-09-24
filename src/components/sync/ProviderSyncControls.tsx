import { useEffect, useState } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';
import { useProviderSync, type SyncProposal } from '../../hooks/useProviderSync';
import { useCalendar } from '../../context/calendar';
import { useTip } from '../../hooks/useTip';
import { notify } from '../../lib/notify';

// The COROS toolbar button + the per-fill confirmation queue card. Mounted
// once in TopNav; also owns the ?connected=coros / ?connect_error=coros
// params the OAuth callback bounces back with, since TopNav is always
// mounted when the redirect lands.
//
// It is also where the COROS tips are offered (src/lib/onboarding/tips/
// coros.ts), because it already holds the connection status — a second
// useProviderSync() would POST a second status request on every load. Every
// one is gated on `configured`: a deployment without COROS hides the feature,
// and a tip about it would be a dead end.

// The coros-connected tip follows the OAuth return rather than landing on it:
// that load already shows a toast, and TipHost shows one tip per load. So the
// return leaves this mark and a LATER load, finding it while connected, offers
// the tip. Per device, not per user — the tip also needs this account to be
// connected, and TipHost remembers "seen" per account, so a lingering mark
// can never show it twice.
const JUST_CONNECTED_KEY = 'apex:coros-just-connected';

function readJustConnected(): boolean {
  try {
    return localStorage.getItem(JUST_CONNECTED_KEY) === '1';
  } catch {
    return false;
  }
}

function markJustConnected() {
  try {
    localStorage.setItem(JUST_CONNECTED_KEY, '1');
  } catch {}
}

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
  // Read once, before the return effect below can write it: on the return
  // load itself this is false, so the tip waits for the next load.
  const [connectedEarlier] = useState(readJustConnected);

  useTip('coros-connected', configured && status === 'connected' && connectedEarlier);
  useTip('coros-fill-queue', configured && pendingFills.length > 0);
  useTip('coros-expired', configured && status === 'expired');

  // OAuth callback return: toast the outcome, clean the URL, re-check status.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const failed = params.get('connect_error');
    if (!connected && !failed) return;
    if (connected === 'coros') {
      notify('COROS connected — press Sync to grab activities');
      markJustConnected();
    }
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
        <div
          className="sync-confirm chat-confirm-card"
          data-testid="sync-confirm-card"
          // chat-confirm-card's tint is 6% over transparent — right inside
          // the chat, where a surface sits under it, but this one floats over
          // the calendar and its text collided with whatever was beneath.
          // Same tint, over an opaque surface.
          style={{ background: 'color-mix(in srgb, var(--positive) 6%, var(--bg-elevated))' }}
        >
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
