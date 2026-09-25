import { useEffect, useState } from 'react';
import { Copy, HelpCircle, X } from 'lucide-react';
import {
  createMcpToken,
  disconnectMcpClient,
  listMcpTokens,
  revokeMcpToken,
  type McpConnectionInfo,
  type McpTokenInfo,
} from '../../lib/api';
import { notify } from '../../lib/notify';
import { publicOrigin } from '../../lib/origin';
import { useTip } from '../../hooks/useTip';
import ProfileDisclosure from './ProfileDisclosure';

// "Claude or ChatGPT" profile section (the connector): mint/list/revoke the
// personal access tokens that authenticate the remote MCP endpoint (/api/mcp).
// The plaintext token is displayed exactly once, right after minting — the
// server stores only its hash. On screen a token is a "code" and the endpoint
// an "address" (docs/onboarding/MASTER.md, "Copy rules"); the Authorization
// header detail lives in ConnectorGuide only.

interface Props {
  /** Opens the illustrated setup guide (ConnectorGuide), owned by ProfileView. */
  onShowGuide: () => void;
}

export default function McpTokens({ onShowGuide }: Props) {
  const [tokens, setTokens] = useState<McpTokenInfo[]>([]);
  const [connections, setConnections] = useState<McpConnectionInfo[]>([]);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  // Offered while the user has the section open, so the tip lands next to
  // the Step-by-step guide link it names. Focus sits on the fold's toggle
  // button, not an input, so TipHost's typing hold does not delay it.
  const [isOpen, setIsOpen] = useState(false);
  useTip('connector-first', isOpen);

  const endpointUrl = `${publicOrigin()}/api/mcp`;

  useEffect(() => {
    listMcpTokens()
      .then(({ tokens, connections }) => {
        setTokens(tokens ?? []);
        setConnections(connections ?? []);
      })
      .catch(() => {}); // toast already shown by the api layer
  }, []);

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(message);
    } catch {
      notify('Copy failed');
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsCreating(true);
    try {
      const { token } = await createMcpToken(trimmed);
      setFreshToken(token);
      setName('');
      const { tokens } = await listMcpTokens();
      setTokens(tokens ?? []);
    } catch {
      // toast already shown
    }
    setIsCreating(false);
  };

  const revoke = async (id: string) => {
    try {
      await revokeMcpToken(id);
      notify('Code revoked');
      setTokens(prev => prev.map(t => (t.id === id ? { ...t, revoked_at: new Date().toISOString() } : t)));
    } catch {
      // toast already shown
    }
  };

  const disconnect = async (clientId: string) => {
    try {
      await disconnectMcpClient(clientId);
      notify('Disconnected');
      setConnections(prev => prev.filter(c => c.client_id !== clientId));
    } catch {
      // toast already shown
    }
  };

  const active = tokens.filter(t => !t.revoked_at);

  return (
    <ProfileDisclosure
      title="Claude or ChatGPT"
      status={active.length > 0 ? `${active.length} code${active.length === 1 ? '' : 's'}` : 'Not set up'}
      onOpenChange={setIsOpen}
      // Outside the toggle button, so the guide is one click away even while
      // the section is collapsed.
      action={(
        <button
          type="button"
          className="profile-help"
          onClick={onShowGuide}
          aria-label="How to connect Claude or ChatGPT — illustrated guide"
          title="Setup guide"
        >
          <HelpCircle size={15} strokeWidth={1.6} />
        </button>
      )}
    >
      <p className="profile-hint">
        Ask Claude or ChatGPT about your training. It can look, but never
        change anything. Tap{' '}
        <button type="button" className="profile-link" onClick={onShowGuide}>
          Step-by-step guide
        </button>{' '}
        to set it up.
      </p>
      <div className="profile-feed">
        <input className="auth-input profile-feed__url" value={endpointUrl} readOnly aria-label="MCP endpoint URL" />
        <button className="btn-today" onClick={() => copy(endpointUrl, 'Address copied')} title="Copy address">
          <Copy size={14} strokeWidth={1.5} />
        </button>
      </div>

      {freshToken && (
        <div className="profile-feed" style={{ marginTop: 8 }}>
          <input className="auth-input profile-feed__url" value={freshToken} readOnly aria-label="New code" />
          <button className="btn-today" onClick={() => copy(freshToken, 'Code copied')} title="Copy code">
            <Copy size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
      {freshToken && (
        <p className="profile-hint">
          Copy this code now. You will not see it again. It stops working in a
          year.
        </p>
      )}

      {connections.length > 0 && (
        <ul className="profile-token-list" style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
          {connections.map(c => (
            <li key={c.client_id} className="profile-feed" style={{ marginBottom: 4 }}>
              <span className="profile-hint" style={{ flex: 1, margin: 0 }}>
                {c.name || 'Connected app'} · signed in {c.created_at.slice(0, 10)}
              </span>
              <button
                className="btn-today"
                onClick={() => disconnect(c.client_id)}
                title={`Disconnect ${c.name || 'app'}`}
                aria-label={`Disconnect ${c.name || 'app'}`}
              >
                <X size={14} strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {active.length > 0 && (
        <ul className="profile-token-list" style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
          {active.map(t => (
            <li key={t.id} className="profile-feed" style={{ marginBottom: 4 }}>
              <span className="profile-hint" style={{ flex: 1, margin: 0 }}>
                {t.name} · …{t.token_last4}
                {t.last_used_at ? ` · last used ${t.last_used_at.slice(0, 10)}` : ' · never used'}
              </span>
              <button className="btn-today" onClick={() => revoke(t.id)} title={`Revoke ${t.name}`} aria-label={`Revoke ${t.name}`}>
                <X size={14} strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="profile-feed">
        <input
          className="auth-input profile-feed__url"
          placeholder="Code name (for example, Claude Desktop)"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={60}
          aria-label="New code name"
        />
        <button type="submit" className="auth-submit" disabled={isCreating || !name.trim()}>
          {isCreating ? 'Creating…' : 'Create code'}
        </button>
      </form>
    </ProfileDisclosure>
  );
}
