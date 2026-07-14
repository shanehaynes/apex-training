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

async function requestJson<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  label: string,
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
    notify(`${label} failed`);
    throw new ApiError(`${label} failed`, null);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[apex] ${label} failed (${res.status}):`, detail);
    // 402 = the caller has no Anthropic API key saved yet — an expected
    // state with dedicated UI (profile setup prompt), not a toast-worthy
    // failure. Callers still get the ApiError.
    if (res.status !== 402) notify(`${label} failed`);
    throw new ApiError(detail || `${label} failed`, res.status);
  }

  return res.json().catch(() => undefined) as Promise<T>;
}

export function getJson<T = unknown>(path: string, label: string): Promise<T> {
  return requestJson<T>('GET', path, undefined, label);
}

export function postJson<T = unknown>(path: string, body: unknown, label: string): Promise<T> {
  return requestJson<T>('POST', path, body, label);
}

export function patchJson<T = unknown>(path: string, body: unknown, label: string): Promise<T> {
  return requestJson<T>('PATCH', path, body, label);
}

export function deleteJson<T = unknown>(path: string, label: string, body?: unknown): Promise<T> {
  return requestJson<T>('DELETE', path, body, label);
}
