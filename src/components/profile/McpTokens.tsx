import { useEffect, useState } from 'react';
import { Copy, X } from 'lucide-react';
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

// "AI connector" profile section: mint/list/revoke the personal access
// tokens that authenticate the remote MCP endpoint (/api/mcp). The plaintext
// token is displayed exactly once, right after minting — the server stores
// only its hash.

export default function McpTokens() {
  const [tokens, setTokens] = useState<McpTokenInfo[]>([]);
  const [connections, setConnections] = useState<McpConnectionInfo[]>([]);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);

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
      notify('Token revoked');
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
    <section className="profile-section">
      <h3 className="profile-section__title">AI connector</h3>
      <p className="profile-hint">
        Query your training data from Claude or ChatGPT. Add this URL as a custom
        connector (or via <code>claude mcp add</code>) and authenticate with an
        access token. Tokens are read-only.
      </p>
      <div className="profile-feed">
        <input className="auth-input profile-feed__url" value={endpointUrl} readOnly aria-label="MCP endpoint URL" />
        <button className="btn-today" onClick={() => copy(endpointUrl, 'Endpoint URL copied')} title="Copy MCP endpoint URL">
          <Copy size={14} strokeWidth={1.5} />
        </button>
      </div>

      {freshToken && (
        <div className="profile-feed" style={{ marginTop: 8 }}>
          <input className="auth-input profile-feed__url" value={freshToken} readOnly aria-label="New access token" />
          <button className="btn-today" onClick={() => copy(freshToken, 'Token copied')} title="Copy token">
            <Copy size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
      {freshToken && (
        <p className="profile-hint">
          Copy this token now — it won't be shown again. Send it as{' '}
          <code>Authorization: Bearer &lt;token&gt;</code>.
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
          placeholder="Token name (e.g. Claude Desktop)"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={60}
          aria-label="New token name"
        />
        <button type="submit" className="auth-submit" disabled={isCreating || !name.trim()}>
          {isCreating ? 'Creating…' : 'Create token'}
        </button>
      </form>
    </section>
  );
}
