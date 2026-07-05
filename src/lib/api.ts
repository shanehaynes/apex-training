import { notify } from './notify';

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

async function requestJson<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  label: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
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
    notify(`${label} failed`);
    throw new ApiError(detail || `${label} failed`, res.status);
  }

  return res.json().catch(() => undefined) as Promise<T>;
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
