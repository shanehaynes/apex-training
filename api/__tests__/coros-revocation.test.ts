import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as corosOauth from '../_lib/providers/coros/oauth';
import {
  COROS_DELETE_NOTICE,
  COROS_DISCONNECT_NOTICE,
  COROS_UPSTREAM_REVOCATION_SUPPORTED,
} from '../../src/lib/sync/corosRevocation';

// Issue #231. Apex cannot revoke a COROS grant, and these assertions are the
// reason on file rather than a claim in a commit message. They read the frozen
// discovery fixture (scripts/coros-spike.mjs writes it) instead of the network,
// so they are deterministic — and so that refreshing the fixture is what makes
// them fail. If COROS ever accepts public clients at its revocation endpoint,
// the third assertion here goes red, and the fix is to write revokeTokens() in
// api/_lib/providers/coros/oauth.ts and call it from disconnect and delete.

interface Discovery {
  'as_metadata:/.well-known/oauth-authorization-server': {
    json: {
      revocation_endpoint?: string;
      revocation_endpoint_auth_methods_supported?: string[];
      token_endpoint_auth_methods_supported?: string[];
    };
  };
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/coros/oauth-discovery.json', import.meta.url)),
  'utf8',
)) as Discovery;

const meta = fixture['as_metadata:/.well-known/oauth-authorization-server'].json;

describe('COROS token revocation', () => {
  it('COROS does advertise an RFC 7009 revocation endpoint', () => {
    expect(meta.revocation_endpoint).toBe('https://mcpus.coros.com/oauth2/revoke');
  });

  it('Apex is a public client — the token endpoint accepts auth method "none"', () => {
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('but the revocation endpoint does NOT accept public clients', () => {
    // The whole finding in one line: every method listed needs a credential
    // Apex does not have (PKCE carries its proof at the token endpoint), and a
    // live probe with a throwaway token answered 401, not the 200 RFC 7009
    // §2.2 requires for a merely invalid token.
    expect(meta.revocation_endpoint_auth_methods_supported).not.toContain('none');
    expect(COROS_UPSTREAM_REVOCATION_SUPPORTED).toBe(false);
  });

  it('ships no revokeTokens() that would silently no-op', () => {
    expect('revokeTokens' in corosOauth).toBe(false);
  });

  it('discloses the surviving grant in both notices', () => {
    for (const notice of [COROS_DISCONNECT_NOTICE, COROS_DELETE_NOTICE]) {
      expect(notice).toMatch(/COROS app/);
      expect(notice).toMatch(/cannot withdraw/);
    }
  });
});
