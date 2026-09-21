// Whether Apex can revoke a COROS OAuth grant on the user's behalf, and what
// we tell the user because it cannot. Shared rather than duplicated: the API
// (api/_lib/handlers/providerSync.ts) and the two places the browser says it
// (Profile → COROS, Profile → Your data) have to say the same thing.
//
// FINDING (2026-09-19, issue #231). COROS's MCP authorization server at
// https://mcpus.coros.com DOES advertise an RFC 7009 revocation endpoint —
// both in its RFC 8414 metadata and in its openid-configuration:
//
//   "revocation_endpoint": "https://mcpus.coros.com/oauth2/revoke",
//   "revocation_endpoint_auth_methods_supported": [
//     "client_secret_basic", "client_secret_post", "client_secret_jwt",
//     "private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth"]
//
// "none" is absent from that list — unlike token_endpoint_auth_methods_supported
// next to it, which has it. Apex is a public client: registered through COROS's
// open DCR with token_endpoint_auth_method "none", holding no client secret,
// with PKCE carrying the proof (api/_lib/providers/coros/oauth.ts). A public
// client cannot authenticate to that revocation endpoint, so Apex cannot use it.
//
// Probed live on 2026-09-19 with a throwaway token string (never a real one):
// POST /oauth2/revoke with a DCR-registered public client_id answered 401 with
// an empty body, and so did the same request with no client_id — where
// RFC 7009 §2.2 requires 200 for a token that is merely invalid. 401 is the
// client-authentication failure, not a token verdict.
//
// That is why there is no revokeTokens() in coros/oauth.ts: one that always
// 401s is the silent no-op issue #231 asks us not to ship. We disclose instead.
// If COROS ever adds "none" to those auth methods, the fixture assertion in
// api/__tests__/coros-revocation.test.ts fails, and revocation becomes
// implementable exactly where that test points.
export const COROS_UPSTREAM_REVOCATION_SUPPORTED = false;

/** Said after a disconnect — in the API response and in the profile section. */
export const COROS_DISCONNECT_NOTICE =
  'Apex deleted its copy of your COROS tokens and can no longer read your watch data. '
  + 'It cannot withdraw the permission you granted at COROS — to do that, remove Apex '
  + 'from your connected apps in the COROS app (Profile → Settings → 3rd Party Apps).';

/** Said before an account deletion, where the same grant survives the delete. */
export const COROS_DELETE_NOTICE =
  'If you connected a COROS account, deletion removes Apex’s copy of your watch '
  + 'tokens, but it cannot withdraw the permission you granted at COROS — remove Apex '
  + 'from your connected apps in the COROS app as well.';
