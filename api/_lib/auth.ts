import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { hasAcceptedCurrent, TERMS_REQUIRED_BODY } from './legal.js';

// The service-role client bypasses RLS, so verifying the caller's JWT and
// stamping/filtering every query by the verified uid IS the security model
// for /api/*. Never trust a user_id arriving in a request body.

/**
 * The bare-string body for "we could not reach Supabase Auth", sent with 503
 * on the same principle as `402 anthropic-key-missing` and
 * `403 terms-acceptance-required`: a distinct state the client detects by
 * status + body rather than by parsing prose.
 */
export const AUTH_UNAVAILABLE_BODY = 'auth-unavailable';

/**
 * Did GoTrue actually judge this token, or did we simply fail to reach it?
 *
 * supabase-js reports a transport failure as an AuthRetryableFetchError:
 * status 0 when fetch itself threw (DNS, connection refused, timeout, abort),
 * and the upstream status when GoTrue — or a gateway in front of it — answered
 * 5xx. Neither is a verdict on the token. An AuthApiError (401/403 from
 * /auth/v1/user) or an AuthSessionMissingError (400) is.
 *
 * The distinction is not cosmetic: the iOS write queue reads 401 as "this
 * session is gone" and pauses, and until G3 ships it signs the user out. A
 * GoTrue blip must not log everyone out, so it gets 503, which
 * RetryPolicy.classify already treats as retryable with backoff.
 *
 * The status check outside isAuthRetryableFetchError is a fallback for an
 * error object that did not come from auth-js's own error classes.
 */
function isAuthServiceUnreachable(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return status === 0 || (typeof status === 'number' && status >= 500);
}

export interface RequireUserOptions {
  /**
   * Skip the terms-acceptance gate. Reserved for the handful of endpoints a
   * user who has NOT accepted still legitimately needs:
   *
   *   /api/terms-acceptance  — accepting is how they get past the gate
   *   GET /api/profile       — the shell needs it to render the modal at all
   *   /api/account           — export and delete are the user exercising
   *                            rights over their own data, and withholding
   *                            those until they agree to new terms is the
   *                            coercive reading we do not want
   *
   * Every other handler is gated by default, which is the point of putting
   * the check here: a new handler is gated because it called requireUser,
   * not because its author remembered to.
   */
  skipTermsGate?: boolean;
}

/**
 * Validate the Authorization: Bearer <jwt> header against Supabase Auth, and
 * (unless exempted) require that the caller has accepted the current legal
 * documents. Sends the error response itself and returns null on failure;
 * otherwise returns the authenticated user's id.
 *
 * The 403 body is the bare string `terms-acceptance-required`, matching the
 * `402 anthropic-key-missing` convention: an expected state with dedicated
 * UI, which the client detects by status + body rather than by parsing prose.
 *
 * 401 means Supabase Auth rejected the token. When Supabase Auth could not be
 * reached at all the answer is `503 auth-unavailable` instead — see
 * isAuthServiceUnreachable above.
 */
export async function requireUser(
  req: VercelRequest,
  res: VercelResponse,
  options: RequireUserOptions = {},
): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return null;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) {
    res.status(401).send('Missing bearer token');
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error && isAuthServiceUnreachable(error)) {
    res.status(503).send(AUTH_UNAVAILABLE_BODY);
    return null;
  }
  if (error || !data.user) {
    res.status(401).send('Invalid or expired token');
    return null;
  }

  if (!options.skipTermsGate && !(await hasAcceptedCurrent(supabase, data.user.id))) {
    res.status(403).send(TERMS_REQUIRED_BODY);
    return null;
  }

  return data.user.id;
}
