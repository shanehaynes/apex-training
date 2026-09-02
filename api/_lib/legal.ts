import type { VercelRequest } from '@vercel/node';
import type { getSupabaseAdmin } from './supabaseAdmin.js';
// .js extension required: this module is in the API's runtime import graph
// (auth.ts → every handler), where Node ESM resolution is strict.
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/lib/legal/versions.js';

// Server side of the clickwrap. The checkbox in the browser is a courtesy;
// THIS is the enforcement, because a disabled submit button is one devtools
// edit away from not existing.
//
// Two responsibilities:
//   1. Record an acceptance (append-only — see the phase39 migration).
//   2. Answer "has this user accepted the current versions?" for the gate
//      folded into requireUser, which every JWT-authed handler already calls.
//
// The versions written to a row come from src/lib/legal/versions.ts, never
// from the request body. A client that could name its own version could
// claim to have accepted a document that was never published.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The wire shape the browser gets back, camelCased like the rest of /api. */
export interface AcceptanceStatus {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string;
}

interface AcceptanceRow {
  terms_version: string;
  privacy_version: string;
  accepted_at: string;
}

/** Counts occurrences of the fail-closed path, for log alerting. */
let failClosedCount = 0;
export function termsGateFailClosedCount(): number {
  return failClosedCount;
}

/**
 * The caller's most recent acceptance, or null when they have never
 * accepted. Throws on a query failure so callers can distinguish "no
 * acceptance" from "could not tell" — those must not be conflated, because
 * one is a normal new-user state and the other is an outage.
 */
export async function latestAcceptance(
  supabase: Admin,
  userId: string,
): Promise<AcceptanceStatus | null> {
  const { data, error } = await supabase
    .from('terms_acceptances')
    .select('terms_version, privacy_version, accepted_at')
    .eq('user_id', userId)
    .order('accepted_at', { ascending: false })
    .limit(1)
    .maybeSingle<AcceptanceRow>();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    termsVersion: data.terms_version,
    privacyVersion: data.privacy_version,
    acceptedAt: data.accepted_at,
  };
}

/** True only when BOTH documents' current versions have been accepted. */
export function isCurrent(status: AcceptanceStatus | null): boolean {
  return status !== null
    && status.termsVersion === TERMS_VERSION
    && status.privacyVersion === PRIVACY_VERSION;
}

/**
 * The gate's question. FAILS CLOSED, unlike the rate limiter next door: a
 * limiter that fails open costs us some quota, whereas a consent gate that
 * fails open lets an induced database error bypass consent entirely. The
 * cost of the choice is that an unapplied phase39 migration 403s every
 * authenticated request — which is why the migration says to run it first,
 * and why the failure is logged under a stable, grep-able tag.
 */
export async function hasAcceptedCurrent(supabase: Admin, userId: string): Promise<boolean> {
  try {
    return isCurrent(await latestAcceptance(supabase, userId));
  } catch (err) {
    failClosedCount += 1;
    console.error(
      `[legal] TERMS-GATE-FAIL-CLOSED #${failClosedCount} — acceptance lookup failed, denying request:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * The client's IP as Vercel reports it. x-forwarded-for is a comma-separated
 * chain and the ORIGINAL client is the first entry; taking the last would
 * record a proxy. Null rather than a placeholder when absent (local dev) —
 * an empty evidence field is honest, a fabricated one is not.
 */
export function clientIp(req: VercelRequest): string | null {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  const first = raw?.split(',')[0]?.trim();
  return first || null;
}

/** The caller's user-agent, bounded — this is evidence, not a free text field. */
export function clientUserAgent(req: VercelRequest): string | null {
  const ua = req.headers['user-agent'];
  const value = Array.isArray(ua) ? ua[0] : ua;
  return value ? value.slice(0, 500) : null;
}

/**
 * Write an acceptance. Always an INSERT: the phase39 trigger rejects UPDATE
 * outright, and the whole point of the table is that accepting v2 leaves the
 * v1 row standing as evidence of what was agreed when.
 */
export async function recordAcceptance(
  supabase: Admin,
  userId: string,
  req: VercelRequest,
): Promise<AcceptanceStatus> {
  const row = {
    user_id: userId,
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    ip: clientIp(req),
    user_agent: clientUserAgent(req),
  };
  const { data, error } = await supabase
    .from('terms_acceptances')
    .insert(row)
    .select('terms_version, privacy_version, accepted_at')
    .single<AcceptanceRow>();
  if (error || !data) throw new Error(error?.message ?? 'Insert returned no row');
  return {
    termsVersion: data.terms_version,
    privacyVersion: data.privacy_version,
    acceptedAt: data.accepted_at,
  };
}

/** The body the gate returns on a 403, and the string the client matches on. */
export const TERMS_REQUIRED_BODY = 'terms-acceptance-required';
