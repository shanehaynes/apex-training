import type { VercelResponse } from '@vercel/node';

// The contract between a service (api/_lib/services/*) and its callers: the
// HTTP handler that maps a failure onto a status, and the coach's server
// deps (api/_lib/coach/serverDeps.ts) that map it onto a boolean/null for
// the tool executors. One implementation of every mutation, two doors.

export type ServiceResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

export function succeed<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(status: number, message: string): ServiceResult<T> {
  return { ok: false, status, message };
}

/** Send a failed result as the handler always did: status + plain-text message. */
export function sendFailure(res: VercelResponse, result: { status: number; message: string }): void {
  res.status(result.status).send(result.message);
}
