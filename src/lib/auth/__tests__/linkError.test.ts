import { describe, it, expect } from 'vitest';
import { parseAuthLinkError } from '../linkError';

describe('parseAuthLinkError', () => {
  it('is null for a clean landing', () => {
    expect(parseAuthLinkError('', '')).toBeNull();
    expect(parseAuthLinkError('#access_token=abc&type=invite')).toBeNull();
  });

  it('turns a spent invite link into an actionable message', () => {
    // Verbatim from GoTrue, captured against the live project with a bogus token.
    const result = parseAuthLinkError(
      '#error=access_denied&error_code=otp_expired'
      + '&error_description=Email+link+is+invalid+or+has+expired&sb=',
    );
    expect(result?.code).toBe('otp_expired');
    expect(result?.message).toMatch(/expired, or it has already been used/);
    expect(result?.message).toMatch(/fresh invite/);
  });

  it('recognises a spent link that carries no error_code', () => {
    expect(parseAuthLinkError('#error=access_denied&error_description=Email+link+is+invalid+or+has+expired')?.message)
      .toMatch(/fresh invite/);
  });

  it('passes through a failure it has no better wording for', () => {
    expect(parseAuthLinkError('#error=server_error&error_description=Database+error+saving+new+user'))
      .toEqual({ code: null, message: 'Database error saving new user' });
  });

  it('names the error when GoTrue sends no description', () => {
    expect(parseAuthLinkError('#error=access_denied')?.message).toBe('Sign-in link failed: access_denied');
  });

  it('reads the query string too, for a PKCE-configured project', () => {
    expect(parseAuthLinkError('', '?error_code=otp_expired&error_description=Email+link+is+invalid')?.code)
      .toBe('otp_expired');
  });

  it('prefers the fragment when both carry an error', () => {
    expect(parseAuthLinkError('#error_description=from+the+fragment', '?error_description=from+the+query')?.message)
      .toBe('from the fragment');
  });
});
