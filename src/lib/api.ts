import { notify } from './notify';
import { supabase } from './supabaseClient';

// Single JSON transport for the app's /api/* endpoints — one place for
// headers, serialization, and error handling. Failures log the response
// detail for debugging, show the user a terse toast, and throw; callers
// decide whether that is fatal (try/catch) or fire-and-forget
// (.catch(() => {})).

export class ApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Authorization header for /api/* calls, from the current Supabase session.
 * Empty in offline mode (supabase === null) or when signed out — the server
 * then answers 401 and the shared error path below surfaces it.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `quiet` suppresses the failure toast (never the console.warn). For calls
 * the user did not ask for and whose failure changes nothing they can see —
 * the coach thread's write-behind save, which is fail-open by design — a
 * toast would report a problem the user has no action to take about.
 */
export interface RequestOptions {
  quiet?: boolean;
}

async function requestJson<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  label: string,
  opts: RequestOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(await authHeaders()),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[apex] ${label} failed:`, err);
    if (!opts.quiet) notify(`${label} failed`);
    throw new ApiError(`${label} failed`, null);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[apex] ${label} failed (${res.status}):`, detail);
    // 402 = the caller has no Anthropic API key saved yet — an expected
    // state with dedicated UI (profile setup prompt), not a toast-worthy
    // failure. Callers still get the ApiError.
    if (res.status !== 402 && !opts.quiet) notify(`${label} failed`);
    throw new ApiError(detail || `${label} failed`, res.status);
  }

  return res.json().catch(() => undefined) as Promise<T>;
}

export function getJson<T = unknown>(path: string, label: string, opts?: RequestOptions): Promise<T> {
  return requestJson<T>('GET', path, undefined, label, opts);
}

export function postJson<T = unknown>(
  path: string,
  body: unknown,
  label: string,
  opts?: RequestOptions,
): Promise<T> {
  return requestJson<T>('POST', path, body, label, opts);
}

export function patchJson<T = unknown>(
  path: string,
  body: unknown,
  label: string,
  opts?: RequestOptions,
): Promise<T> {
  return requestJson<T>('PATCH', path, body, label, opts);
}

export function deleteJson<T = unknown>(path: string, label: string, body?: unknown): Promise<T> {
  return requestJson<T>('DELETE', path, body, label);
}

// ── Legal acceptance and account data rights ──────────────────────────────────

/** One row of the append-only acceptance ledger, as /api/* reports it. */
export interface AcceptanceStatus {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string;
}

/**
 * Record acceptance of the current Terms and Privacy Policy. Takes no body:
 * the versions are the server's own constants, so there is nothing for the
 * client to assert (api/_lib/legal.ts).
 */
export function acceptTerms(): Promise<{ accepted: AcceptanceStatus; current: boolean }> {
  return postJson('/api/terms-acceptance', undefined, 'Recording acceptance');
}

/**
 * Download the account export. Deliberately not getJson: the response is a
 * file attachment the user saves, so it goes straight to a blob and never
 * through the JSON parser.
 */
export async function downloadAccountExport(): Promise<void> {
  const res = await fetch('/api/account', { headers: await authHeaders() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[apex] Export failed (${res.status}):`, detail);
    notify('Export failed');
    throw new ApiError(detail || 'Export failed', res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `apex-training-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Irreversible. The confirm string is checked server-side too. */
export function deleteAccount(): Promise<{ ok: boolean }> {
  return deleteJson('/api/account', 'Account deletion', { confirm: 'DELETE' });
}

// ── MCP connector tokens ──────────────────────────────────────────────────────

export interface McpTokenInfo {
  id: string;
  name: string;
  token_last4: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface McpConnectionInfo {
  client_id: string;
  name: string;
  created_at: string;
}

export function listMcpTokens(): Promise<{ tokens: McpTokenInfo[]; connections?: McpConnectionInfo[] }> {
  return getJson('/api/mcp-tokens', 'Token list');
}

/** Disconnect an OAuth client: revokes all its live access + refresh tokens. */
export function disconnectMcpClient(clientId: string): Promise<{ ok: boolean }> {
  return deleteJson(`/api/mcp-tokens?client_id=${encodeURIComponent(clientId)}`, 'Disconnect');
}

/** Consent decision for the OAuth /connect page; returns the redirect target. */
export function approveOauth(fields: Record<string, string>): Promise<{ redirect_to: string }> {
  return postJson('/api/oauth-approve', fields, 'Authorization');
}

/** The returned plaintext token is shown once and never retrievable again. */
export function createMcpToken(name: string): Promise<{ id: string; token: string }> {
  return postJson('/api/mcp-tokens', { name }, 'Token creation');
}

export function revokeMcpToken(id: string): Promise<{ ok: boolean }> {
  return deleteJson(`/api/mcp-tokens?id=${encodeURIComponent(id)}`, 'Token revocation');
}

// ── Coach conversations (thread persistence, D-013) ───────────────────────────

export type CoachMode = 'chat' | 'builder' | 'analytics';

/** A stored thread, as /api/coach-conversations reports it. */
export interface CoachConversation {
  id: string;
  mode: CoachMode;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One stored message. Both halves are nullable and exactly one may be absent
 * (docs/ios/decisions.md D-025): `api_content` is null on a display-only row
 * (a notice, a stopped partial), `display_text` is null on a hidden row —
 * the synthetic briefing prompt the model needs and the thread never shows.
 */
export interface StoredCoachMessage {
  id: string;
  role: 'user' | 'assistant';
  api_content: unknown;
  display_text: string | null;
  kind: 'turn' | 'notice' | 'stopped';
  created_at: string;
}

/** A message on its way in — the server mints the id and the timestamp. */
export type NewCoachMessage = Omit<StoredCoachMessage, 'id' | 'created_at'>;

/**
 * Both reads are QUIET for the same reason the append is: they run on mount,
 * nobody asked for them, and a thread that fails to hydrate is the empty
 * thread the app had before this existed. Offline mode (no Supabase session)
 * answers 401 on every one of them and must not toast for it.
 */
export function listCoachConversations(mode: CoachMode): Promise<{ conversations: CoachConversation[] }> {
  return getJson(`/api/coach-conversations?mode=${encodeURIComponent(mode)}`, 'Loading conversations', { quiet: true });
}

export function loadCoachConversation(
  id: string,
): Promise<{ conversation: CoachConversation; messages: StoredCoachMessage[] }> {
  return getJson(`/api/coach-conversations?id=${encodeURIComponent(id)}`, 'Loading conversation', { quiet: true });
}

export function createCoachConversation(
  mode: CoachMode,
  title?: string,
): Promise<{ conversation: CoachConversation }> {
  return postJson('/api/coach-conversations', { mode, ...(title ? { title } : {}) }, 'Starting a thread');
}

/**
 * Write-behind append. QUIET on purpose: the thread has already rendered
 * these messages and keeps working without them, so a failure is a
 * console.warn and nothing the user is asked to react to — there is no
 * action the user could take about it, and the alternative to a saved thread
 * is the in-memory thread they already have.
 */
export function appendCoachMessages(
  id: string,
  messages: NewCoachMessage[],
): Promise<{ ok: boolean; messages: StoredCoachMessage[] }> {
  return postJson('/api/coach-conversations', { id, messages }, 'Saving conversation', { quiet: true });
}

export function renameCoachConversation(id: string, title: string): Promise<{ conversation: CoachConversation }> {
  return patchJson('/api/coach-conversations', { id, title }, 'Renaming conversation');
}

export function deleteCoachConversation(id: string): Promise<{ ok: boolean }> {
  return deleteJson('/api/coach-conversations', 'Deleting conversation', { id });
}
