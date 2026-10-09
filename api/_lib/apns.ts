import { connect } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { optionalEnv } from './env.js';

// The Apple Push Notification service, for exactly one thing: ending the iOS
// app's Live Activity when a workout is finished somewhere the phone cannot
// see (services/liveActivity.ts). Token-based auth (a .p8 key signs a short
// JWT) over HTTP/2, both straight from node: — no dependency for one POST.
//
// APNs wants the provider token refreshed no more often than every 20 minutes
// and rejects one older than an hour, so it is cached for 50 minutes. The
// cache is per warm function instance; a cold start signs a fresh one.

export type ApnsEnvironment = 'sandbox' | 'production';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: KeyObject;
}

export interface ApnsRequest {
  token: string;
  environment: ApnsEnvironment;
  /** The `apns-topic` header. */
  topic: string;
  pushType: 'liveactivity' | 'alert' | 'background';
  priority: 5 | 10;
  payload: unknown;
}

export interface ApnsResult {
  status: number;
  /** APNs' `reason` on a failure (BadDeviceToken, ExpiredToken, …). */
  reason?: string;
}

/** Sends one request; injectable so tests never open a socket. */
export type ApnsTransport = (host: string, headers: Record<string, string>, body: string) => Promise<ApnsResult>;

const HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

const TOKEN_TTL_MS = 50 * 60 * 1000;
const TIMEOUT_MS = 4000;

/** The key, read from env; null when any of the three is unset. */
export function apnsConfig(): ApnsConfig | null {
  const keyId = optionalEnv('APNS_KEY_ID');
  const teamId = optionalEnv('APNS_TEAM_ID');
  const pem = optionalEnv('APNS_PRIVATE_KEY');
  if (!keyId || !teamId || !pem) return null;
  try {
    // Vercel's dashboard keeps newlines, a one-line .env needs \n escapes;
    // accept both.
    return { keyId, teamId, privateKey: createPrivateKey(pem.replace(/\\n/g, '\n')) };
  } catch (err) {
    console.error('[apns] APNS_PRIVATE_KEY is not a readable PEM key:', err instanceof Error ? err.message : err);
    return null;
  }
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** An ES256 provider token: `{alg, kid}.{iss, iat}` signed with the .p8 key. */
export function providerToken(config: ApnsConfig, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
  const input = `${header}.${claims}`;
  // JWS wants the raw r||s signature, not node's default DER encoding.
  const signature = sign('sha256', Buffer.from(input), { key: config.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

let cached: { keyId: string; token: string; mintedAt: number } | null = null;

function cachedProviderToken(config: ApnsConfig, nowMs: number): string {
  if (cached && cached.keyId === config.keyId && nowMs - cached.mintedAt < TOKEN_TTL_MS) return cached.token;
  const token = providerToken(config, nowMs);
  cached = { keyId: config.keyId, token, mintedAt: nowMs };
  return token;
}

/** For tests: forget the cached provider token. */
export function resetApnsTokenCache(): void {
  cached = null;
}

export const http2Transport: ApnsTransport = (host, headers, body) =>
  new Promise(resolve => {
    const session = connect(host);
    const done = (result: ApnsResult) => {
      clearTimeout(timer);
      session.close();
      resolve(result);
    };
    // A push is best-effort: never let a slow or dead APNs hold the
    // request that triggered it past a few seconds.
    const timer = setTimeout(() => {
      session.destroy();
      resolve({ status: 0, reason: 'Timeout' });
    }, TIMEOUT_MS);
    session.on('error', err => done({ status: 0, reason: err.message }));
    const stream = session.request(headers);
    let status = 0;
    let text = '';
    stream.setEncoding('utf8');
    stream.on('response', h => { status = Number(h[':status'] ?? 0); });
    stream.on('data', chunk => { text += chunk; });
    stream.on('end', () => {
      let reason: string | undefined;
      if (text) {
        try { reason = (JSON.parse(text) as { reason?: string }).reason; } catch { reason = text; }
      }
      done({ status, reason });
    });
    stream.on('error', err => done({ status: 0, reason: err.message }));
    stream.end(body);
  });

export async function sendApns(
  config: ApnsConfig,
  request: ApnsRequest,
  transport: ApnsTransport = http2Transport,
  nowMs: number = Date.now(),
): Promise<ApnsResult> {
  const headers = {
    ':method': 'POST',
    ':path': `/3/device/${request.token}`,
    authorization: `bearer ${cachedProviderToken(config, nowMs)}`,
    'apns-topic': request.topic,
    'apns-push-type': request.pushType,
    'apns-priority': String(request.priority),
    'content-type': 'application/json',
  };
  return transport(HOSTS[request.environment], headers, JSON.stringify(request.payload));
}
