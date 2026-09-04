import { describe, it, expect } from 'vitest';
import { appHandoffUrl } from '../landing';

describe('appHandoffUrl', () => {
  it('hands an invite fragment to the app unchanged', () => {
    const hash = '#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer&type=invite';
    expect(appHandoffUrl(hash)).toBe(`apextraining://auth${hash}`);
  });

  it('hands a recovery fragment over too', () => {
    expect(appHandoffUrl('#access_token=AT&refresh_token=RT&type=recovery'))
      .toBe('apextraining://auth#access_token=AT&refresh_token=RT&type=recovery');
  });

  it('hands a PKCE code over, which only the app can exchange', () => {
    expect(appHandoffUrl('', '?code=abc%2Fdef')).toBe('apextraining://auth?code=abc%2Fdef');
  });

  it('offers nothing on an ordinary landing, a plain sign-in or a refused link', () => {
    expect(appHandoffUrl('', '')).toBeNull();
    expect(appHandoffUrl('#access_token=AT&refresh_token=RT&type=magiclink')).toBeNull();
    expect(appHandoffUrl('#error=access_denied&error_code=otp_expired')).toBeNull();
    expect(appHandoffUrl('#type=invite')).toBeNull();
  });
});
