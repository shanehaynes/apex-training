import type { VercelRequest } from '@vercel/node';
import { optionalEnv } from './env.js';

// Which client made the call, and which clients the server still serves.
//
// The web and the API deploy together — atomically — so the API could always
// assume a caller no older than itself. An App Store binary breaks that: a
// build from six months ago is still running, still sending yesterday's
// columns, and pickAllowed (allowlist.ts) 400s an unknown key, which
// RetryPolicy maps to a permanent failure. Two halves answer it:
//
// - every request carries `X-Apex-Client`, so a log line says which build
//   produced the traffic (and, eventually, which builds are still out there);
// - /api/version publishes a floor, so a build below it can be told to update
//   rather than failing one write at a time.
//
// The floor is a body field, not a response header: the Hono bridge in app.ts
// covers the catch-all only, so a header set there would be absent from
// api/chat.ts, api/calendar-feed.ts and api/review-cron.ts.

/** Header the app stamps: `ios/<CFBundleShortVersionString>+<CFBundleVersion>`. */
export const CLIENT_HEADER = 'x-apex-client';

const MAX_TAG_LENGTH = 64;

/**
 * The caller's `X-Apex-Client`, or undefined when there is none (a browser).
 *
 * The value goes into server logs, so it is sanitised at the boundary rather
 * than at each log site: anything but the characters a build tag can contain
 * is dropped, and the result is capped. A newline in a log line is how one
 * request forges another.
 */
export function clientTag(req: VercelRequest): string | undefined {
  const raw = req.headers[CLIENT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9._+/-]/g, '').slice(0, MAX_TAG_LENGTH);
  return cleaned ? cleaned : undefined;
}

/**
 * The oldest `CFBundleVersion` the server still serves. 0 — the default —
 * gates nothing, which is the only safe value until a build worth forcing off
 * actually exists. Set APEX_MIN_BUILD in Vercel to raise it.
 *
 * A non-integer or negative value is treated as unset: a typo in a dashboard
 * field must not lock every installed build out of the app.
 */
export function minBuild(): number {
  const raw = optionalEnv('APEX_MIN_BUILD');
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

/** What the blocking screen says, when the deployment wants to say something. */
export function updateMessage(): string | undefined {
  return optionalEnv('APEX_UPDATE_MESSAGE');
}
