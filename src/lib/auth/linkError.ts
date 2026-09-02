// Why an invite or password-reset link can dump someone on the sign-in card.
//
// GoTrue verifies the token server-side and then redirects to the app. A
// refusal arrives as the *absence* of a session plus an error in the URL
// fragment:
//
//   /#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
//
// Without this the visitor sees an ordinary sign-in screen and no reason at
// all — and the one thing they reach for next, "Create account", is closed
// (accounts are invite-only), so they end up told their invitation does not
// exist. Invite tokens are single-use and expire, so this is the ordinary
// failure of a link clicked twice, not an exotic one.

/** A refusal carried back from GoTrue on an invite/recovery link. */
export interface AuthLinkError {
  /** GoTrue's machine-readable code, e.g. `otp_expired`. Absent on old links. */
  code: string | null;
  /** What the visitor is shown. */
  message: string;
}

// GoTrue's own wording ("Email link is invalid or has expired") states the
// problem but not the way out, which is the half that matters here.
const EXPIRED_MESSAGE = 'That invite or reset link has expired, or it has already been used. '
  + 'Ask for a fresh invite — or, if you already set a password, sign in below.';

/** True for the codes that mean "the link is spent", however GoTrue spells it. */
function isSpentLink(code: string | null, description: string | null): boolean {
  if (code === 'otp_expired') return true;
  // Links mailed before error_code existed carry only the description.
  return !code && /expired|invalid/i.test(description ?? '');
}

/**
 * The link failure encoded in a landing URL, or null if there isn't one.
 *
 * Reads the fragment first (the implicit flow GoTrue uses for us) and falls
 * back to the query string, which is where a PKCE-configured project would
 * put the same fields. Both are the browser's raw `location.hash` /
 * `location.search`, leading `#`/`?` optional.
 */
export function parseAuthLinkError(hash: string, search = ''): AuthLinkError | null {
  const fromHash = readError(hash.replace(/^#/, ''));
  return fromHash ?? readError(search.replace(/^\?/, ''));
}

function readError(query: string): AuthLinkError | null {
  const params = new URLSearchParams(query);
  const code = params.get('error_code');
  const description = params.get('error_description');
  const error = params.get('error');
  if (!code && !description && !error) return null;

  if (isSpentLink(code, description)) return { code: code ?? null, message: EXPIRED_MESSAGE };
  // Anything else: GoTrue's description is the most specific thing we have.
  return { code: code ?? null, message: description || `Sign-in link failed: ${error}` };
}
