import type { VercelResponse } from '@vercel/node';

// Which write failures are the request's fault, and which are ours.
//
// The native write queue retries a 5xx with backoff forever and fails a 4xx
// permanently (ios/Packages/ApexCore/Sources/ApexCore/Cache/RetryPolicy.swift).
// So answering 500 to a row Postgres will refuse on every attempt manufactures
// an infinite retry loop out of a payload that can never land — the queue
// spins, the battery drains, and the op never resolves either way. The
// inverse mistake is worse: 400 for a connection reset drops a real workout.
//
// SQLSTATE is the only signal that separates them reliably. PostgREST hands
// the class straight through in `error.code`.

/**
 * The bare-string body for a write the database rejected on its own terms,
 * on the `402 anthropic-key-missing` / `403 terms-acceptance-required`
 * convention: a distinct state the client detects by status + body rather
 * than by parsing prose. The message is deliberately not the Postgres text —
 * that names columns and constraints, and it goes to the log instead.
 */
export const CONSTRAINT_VIOLATION_BODY = 'constraint-violation';

/** The shape of a PostgrestError, loosened to whatever a caller actually holds. */
export interface PgErrorLike {
  code?: string | null;
  message?: string | null;
}

/**
 * Class 23 — integrity constraint violation (not-null, foreign key, unique,
 * check, exclusion) — and class 22 — data exception (string too long, numeric
 * out of range, invalid text representation, bad datetime) — are both verdicts
 * on the VALUES sent. Retrying byte-identical rows gets a byte-identical
 * refusal, so they are 400.
 *
 * Everything else stays 500: connection failures (08xxx), serialization
 * failures and deadlocks (40xxx), insufficient resources (53xxx), operator
 * intervention (57xxx) and an absent code are all states a later attempt may
 * well survive.
 */
export function isPermanentWriteError(error: PgErrorLike | null | undefined): boolean {
  const code = error?.code;
  if (typeof code !== 'string') return false;
  const sqlstateClass = code.slice(0, 2);
  return sqlstateClass === '23' || sqlstateClass === '22';
}

/**
 * Send a failed write with the status its SQLSTATE earns. `context` is the
 * log prefix ('[api/workout-sessions] save'); `retryableMessage` is the prose
 * the 500 keeps, for the browser, which only ever toasts a label anyway.
 */
export function sendWriteFailure(
  res: VercelResponse,
  context: string,
  error: PgErrorLike | null | undefined,
  retryableMessage: string,
): void {
  if (isPermanentWriteError(error)) {
    console.error(`${context} rejected by Postgres (${error?.code}):`, error?.message);
    res.status(400).send(CONSTRAINT_VIOLATION_BODY);
    return;
  }
  console.error(`${context} failed:`, error?.message);
  res.status(500).send(retryableMessage);
}
