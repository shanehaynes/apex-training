import { useMemo, useState } from 'react';
import { approveOauth } from '../../lib/api';

// OAuth consent page, served at /connect (the SPA rewrite covers the path;
// App.tsx routes here by pathname). The authorize endpoint validated the
// client and redirect before handing off, and oauth-approve re-validates
// everything server-side — this page only collects the human yes/no.

const PARAM_KEYS = ['client_id', 'redirect_uri', 'code_challenge', 'scope', 'resource', 'state'] as const;

export default function ConnectApproval() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientName = params.get('client_name') || 'An MCP client';
  const missing = !params.get('client_id') || !params.get('redirect_uri') || !params.get('code_challenge');
  // The scope the authorize endpoint validated and echoed. None named means
  // the server's default grant — full access (api/_lib/oauth/common.ts) —
  // so the page must say so; only an explicit mcp:read-only request is a
  // read-only connection.
  const scope = params.get('scope');
  const canWrite = !scope || scope.split(/\s+/).includes('mcp:write');

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    const fields: Record<string, string> = { decision };
    for (const key of PARAM_KEYS) {
      const value = params.get(key);
      if (value) fields[key] = value;
    }
    try {
      const { redirect_to } = await approveOauth(fields);
      window.location.href = redirect_to;
    } catch {
      setError('Something went wrong — try connecting again from the client.');
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1 className="auth-title">Connection request invalid</h1>
          <p className="profile-hint">
            This page is opened by an AI client connecting to your training data.
            Start the connection from Claude or ChatGPT instead.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">Allow access?</h1>
        {canWrite ? (
          <>
            <p className="profile-hint">
              <strong>{clientName}</strong> wants <strong>full</strong> access to
              your Apex Training account: it can read your workouts, logs,
              personal records, training blocks, exercise library, meals, notes
              and coach memory, and it can <strong>change them</strong> — log
              workouts, add or delete events, track meals, edit blocks and
              your profile.
            </p>
            <p className="profile-hint">
              Every change it makes is listed under Coach activity in your
              profile, and no more than 200 changes a day are allowed. You can
              disconnect it there at any time.
            </p>
          </>
        ) : (
          <p className="profile-hint">
            <strong>{clientName}</strong> wants <strong>read-only</strong> access to
            your Apex Training data: workouts, logs, personal records, training
            blocks, exercise library, meals, notes and coach memory. It can
            never modify anything.
          </p>
        )}
        {error && <p className="auth-error">{error}</p>}
        <div className="profile-feed">
          <button className="auth-submit" onClick={() => decide('approve')} disabled={busy}>
            {busy ? 'Working…' : 'Allow'}
          </button>
          <button className="btn-today" onClick={() => decide('deny')} disabled={busy}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
