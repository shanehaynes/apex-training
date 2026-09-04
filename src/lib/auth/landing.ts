// Handing an auth link to the native app (docs/ios/decisions.md D-020).
//
// Dashboard invites and password-recovery emails are built from the Supabase
// Site URL, so they land here, on the web, with the session in the fragment
// (implicit flow) — there is no per-invite redirect the dashboard could send
// to the app instead. The web therefore offers the hand-off itself: a plain
// link to `apextraining://auth` carrying the very same fragment, which the
// app turns into a session with setSession. On a phone with the app
// installed the link opens it; anywhere else it is inert and the web flow
// continues as before.
//
// A `?code=` landing is the other shape: a PKCE code the app requested for a
// password reset. Only the app that asked holds the verifier, so the web
// cannot exchange it — the hand-off is the only way forward for that code.

export const APP_AUTH_URL = 'apextraining://auth';

/** The app URL to hand this landing to, or null when there is nothing to hand over. */
export function appHandoffUrl(hash: string, search = ''): string | null {
  const fragment = hash.replace(/^#/, '');
  const fragmentParams = new URLSearchParams(fragment);
  const type = fragmentParams.get('type');
  if (fragmentParams.get('access_token') && (type === 'invite' || type === 'recovery')) {
    return `${APP_AUTH_URL}#${fragment}`;
  }
  const code = new URLSearchParams(search.replace(/^\?/, '')).get('code');
  if (code) return `${APP_AUTH_URL}?code=${encodeURIComponent(code)}`;
  return null;
}
