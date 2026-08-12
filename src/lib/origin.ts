// The canonical origin this deployment publishes as, for URLs that leave the
// browser: the MCP endpoint pasted into Claude, the ICS feed pasted into a
// calendar app, the redirect stamped into a password-reset email.
//
// window.location.origin is wrong for those. A user sitting on a Vercel
// deployment URL (apex-training-<hash>.vercel.app) would copy that host into
// an external system that has no session with it — a calendar app fetching
// such a feed gets Vercel's SSO redirect, not ICS — and deployment URLs are
// per-build, so it breaks again on the next deploy.
//
// VITE_PUBLIC_ORIGIN is baked in at build time. Unset (local dev, e2e) falls
// back to the current origin, which is what those need. Keep it in sync with
// the server-side publicOrigin() in api/_lib/oauth/common.ts — same variable,
// same job.

/** Origin part of a configured URL, or undefined if it isn't a usable one. */
function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    console.warn(`VITE_PUBLIC_ORIGIN is not a URL: ${value} — falling back to window.location.origin`);
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    console.warn(`VITE_PUBLIC_ORIGIN is not http(s): ${value} — falling back to window.location.origin`);
    return undefined;
  }
  return url.origin;
}

export function publicOrigin(): string {
  return (
    normalizeOrigin(import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined)
    ?? window.location.origin
  );
}
