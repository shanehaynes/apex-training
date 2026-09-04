import { appHandoffUrl } from '../../lib/auth/landing';

// Captured at module init for the same reason AuthContext captures the hash:
// supabase-js consumes the fragment while detecting the session, so by the
// time a component renders it may be gone.
const handoffUrl = typeof window !== 'undefined'
  ? appHandoffUrl(window.location.hash, window.location.search)
  : null;

/** "Open in the Apex app" — shown only when the landing carries something the app can use (D-020). */
export default function OpenInAppButton() {
  if (!handoffUrl) return null;
  return (
    <a className="auth-submit auth-submit--app" href={handoffUrl} data-testid="open-in-app">
      Open in the Apex app
    </a>
  );
}
