import { useProviderSync } from '../../hooks/useProviderSync';
import { useTip } from '../../hooks/useTip';
import ProfileDisclosure from './ProfileDisclosure';

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
  const {
    status, configured, lastSyncedAt, isConnecting,
    startConnect, disconnect, disconnectNotice, autoSync, setAutoSync,
  } = useProviderSync();

  // Same id ProviderSyncControls offers from the nav: whichever screen the
  // user is on when the link has run out, the tip can land there.
  useTip('coros-expired', configured && status === 'expired');

  if (!configured) return null;

  return (
    <ProfileDisclosure
      title="COROS"
      status={status === 'connected' ? 'Connected' : status === 'expired' ? 'Reconnect needed' : 'Not connected'}
      // An expired connection is silently not syncing: open the fold so the
      // reconnect button is in front of the user rather than one click away.
      defaultOpen={status === 'expired'}
    >
      {status === 'connected' ? (
        <>
          <p className="profile-hint">
            Connected · last brought in {formatWhen(lastSyncedAt)}. Tap Sync above the
            calendar to bring in new activities. One that matches a planned workout
            asks to fill it. The rest come in as their own workouts.
          </p>
          <label className="coros-auto-sync">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={e => setAutoSync(e.target.checked)}
            />
            Bring in new activities every night (about 11:30 PM Eastern).
          </label>
          <p className="profile-hint">
            Activities that match a planned workout wait for your yes. Sync shows a
            number when any are waiting.
          </p>
          <p className="profile-hint">
            Disconnect COROS deletes Apex's link to your COROS account. COROS still lists
            Apex as allowed. To remove it there, open the COROS app. Go to Profile →
            Settings → 3rd Party Apps and remove Apex.
          </p>
          <button className="auth-submit" onClick={disconnect}>
            Disconnect COROS
          </button>
        </>
      ) : status === 'expired' ? (
        <>
          <p className="profile-hint">
            The link to COROS has run out. Sign in again so new activities keep coming
            in. Nothing you brought in is lost.
          </p>
          <button className="auth-submit" onClick={startConnect} disabled={isConnecting}>
            {isConnecting ? 'Redirecting…' : 'Reconnect COROS'}
          </button>
        </>
      ) : (
        <>
          {disconnectNotice && (
            <p className="profile-hint" role="status">{disconnectNotice}</p>
          )}
          <p className="profile-hint">
            Connect your COROS account to bring your activities into the calendar. They
            come with heart rate, route and climb. You sign in on the COROS site. Apex
            never sees your COROS password.
          </p>
          <button className="auth-submit" onClick={startConnect} disabled={isConnecting}>
            {isConnecting ? 'Redirecting…' : 'Connect COROS'}
          </button>
        </>
      )}
    </ProfileDisclosure>
  );
}
