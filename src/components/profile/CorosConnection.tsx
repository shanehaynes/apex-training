import { useProviderSync } from '../../hooks/useProviderSync';

// Profile → COROS connection management. Self-contained section block
// (McpTokens precedent) so ProfileView only gains one line. The sync
// button itself lives in the calendar toolbar; this section owns connect,
// reconnect, and disconnect.

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function CorosConnection() {
  const { status, configured, lastSyncedAt, isConnecting, startConnect, disconnect, autoSync, setAutoSync } = useProviderSync();

  if (!configured) return null;

  return (
    <section className="profile-section">
      <h3 className="profile-section__title">COROS</h3>
      {status === 'connected' ? (
        <>
          <p className="profile-hint">
            Connected · last synced {formatWhen(lastSyncedAt)}. Grab new activities with
            the Sync button above the calendar — activities matching a planned workout
            offer to fill it; everything else lands as its own event.
          </p>
          <label className="coros-auto-sync">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={e => setAutoSync(e.target.checked)}
            />
            Sync automatically every night (~11:30 PM ET). Unmatched activities import
            on their own; matches to planned workouts wait for your confirmation — the
            Sync button shows a badge when any are waiting.
          </label>
          <button className="auth-submit" onClick={disconnect}>
            Disconnect COROS
          </button>
        </>
      ) : status === 'expired' ? (
        <>
          <p className="profile-hint">
            The COROS connection expired — sign in again to keep syncing. Your imported
            activities are untouched.
          </p>
          <button className="auth-submit" onClick={startConnect} disabled={isConnecting}>
            {isConnecting ? 'Redirecting…' : 'Reconnect COROS'}
          </button>
        </>
      ) : (
        <>
          <p className="profile-hint">
            Connect your COROS account to pull activities — with heart rate, GPS, and
            elevation — straight into the calendar. You'll sign in on COROS's site;
            Apex never sees your COROS password.
          </p>
          <button className="auth-submit" onClick={startConnect} disabled={isConnecting}>
            {isConnecting ? 'Redirecting…' : 'Connect COROS'}
          </button>
        </>
      )}
    </section>
  );
}
