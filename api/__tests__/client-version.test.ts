import { describe, it, expect } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import { clientTag, CLIENT_HEADER } from '../_lib/clientVersion';

const req = (value?: string | string[]) =>
  ({ headers: value === undefined ? {} : { [CLIENT_HEADER]: value } }) as unknown as VercelRequest;

describe('clientTag', () => {
  it('reads the build tag the app stamps', () => {
    expect(clientTag(req('ios/0.6.0+312'))).toBe('ios/0.6.0+312');
  });

  it('is undefined for a browser, which sends no such header', () => {
    expect(clientTag(req())).toBeUndefined();
    expect(clientTag(req(''))).toBeUndefined();
  });

  // The value is logged, so the boundary — not each log site — is where a
  // newline stops being able to forge a second log line.
  it('strips anything a build tag cannot contain', () => {
    expect(clientTag(req('ios/0.6.0+312\n[api/chat] usage {}'))).toBe('ios/0.6.0+312api/chatusage');
    expect(clientTag(req('\r\n\t'))).toBeUndefined();
  });

  it('caps the length', () => {
    expect(clientTag(req('i'.repeat(200)))?.length).toBe(64);
  });

  it('takes the first value when the header is repeated', () => {
    expect(clientTag(req(['ios/0.6.0+312', 'ios/0.1.0+1']))).toBe('ios/0.6.0+312');
  });
});
