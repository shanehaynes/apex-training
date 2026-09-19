import { optionalEnv } from './env.js';

// The one seam every unhandled API error passes through (app.ts's bridge).
//
// WHY THIS EXISTS
// Nothing watched production. A handler that threw produced a 500 and one
// Vercel log line, on a plan with no log drains and about an hour of
// retention, which nobody reads at 3am. rateLimit.ts already logs a
// grep-able RATE-LIMIT-FAIL-OPEN tag "for Vercel log alerts" that no alert
// consumes, for the same reason: there was no consumer to point at.
//
// WHY NOT SENTRY (yet)
// @sentry/node is a dependency, a bundle-size cost on a 12-function Hobby
// plan, and a signup Shane has to do. This is the seam that makes either
// answer a one-line change: today it writes a single structured line that a
// log search can key on, and if APEX_ERROR_WEBHOOK_URL is set it also POSTs
// the same JSON to an HTTP endpoint — a Sentry ingest URL, a Slack/Discord
// webhook, a Vercel-hosted forwarder, anything that accepts a POST. No SDK,
// no vendor lock, and nothing to configure for it to keep working as it does
// now.
//
// RULES THIS FILE OBEYS
// - It never throws. Reporting a failure must not become a second failure,
//   and the caller is already on its way to a 500.
// - It never reports a value that could be a secret: the message, the stack
//   and the route, nothing from the request body, headers or query.
// - It is bounded. The POST gets one attempt and a short timeout, because a
//   serverless invocation billed by the second must not hang on a webhook
//   that is itself down.

/** Where the error came from, for the log line and the webhook payload. */
export interface ErrorContext {
  /** Route or subsystem, e.g. "/api/events". */
  route: string;
  /** HTTP method, when there is one. */
  method?: string;
}

const WEBHOOK_TIMEOUT_MS = 2000;
/** Stacks can be enormous; a log line that wraps forty times is not read. */
const MAX_STACK_CHARS = 4000;

function describe(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.slice(0, MAX_STACK_CHARS),
    };
  }
  return { name: typeof err, message: String(err).slice(0, MAX_STACK_CHARS) };
}

/**
 * Record an unhandled error. Always logs; also POSTs when
 * APEX_ERROR_WEBHOOK_URL is set. Resolves even when everything about the
 * reporting failed — callers must not have to guard it.
 */
export async function reportError(err: unknown, context: ErrorContext): Promise<void> {
  const { name, message, stack } = describe(err);
  const event = {
    // A stable, grep-able tag, like rateLimit.ts's — this is what a Vercel
    // log alert (or a drain's search) keys on before there is a webhook.
    tag: 'APEX-API-ERROR',
    route: context.route,
    method: context.method,
    name,
    message,
    at: new Date().toISOString(),
  };

  // One line, JSON, so a log search can parse it; the stack goes after it
  // rather than inside, so the parseable part stays on one line.
  try {
    console.error(`[apex/error] ${JSON.stringify(event)}`);
    if (stack) console.error(stack);
  } catch {
    // Console is not supposed to throw, but a thrown reporter is worse than
    // a lost report.
  }

  const webhook = optionalEnv('APEX_ERROR_WEBHOOK_URL');
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, stack }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    // Deliberately silent about the webhook itself: the line above already
    // recorded the real error, and a webhook outage must not turn one failed
    // request into two log entries per request.
  }
}
