#!/usr/bin/env node
// COROS MCP discovery + verification spike. Two modes:
//
//   node scripts/coros-spike.mjs discover
//     Non-interactive: unauthenticated initialize (expect 401 + WWW-Authenticate),
//     RFC 9728/8414 discovery docs, and a dynamic-client-registration probe.
//     Findings from 2026-08-10 are frozen in api/__tests__/fixtures/coros/oauth-discovery.json:
//     auth server https://mcpus.coros.com, auth-code + PKCE S256, refresh_token grant,
//     scopes "openid mcp.tools offline_access", open DCR at /connect/register,
//     public clients (token_endpoint_auth_method "none") with arbitrary https redirects.
//
//   node scripts/coros-spike.mjs login
//     Interactive: registers a throwaway localhost client via DCR, opens the COROS
//     sign-in URL (printed — open it yourself), catches the redirect on
//     http://localhost:8787/callback, exchanges the code with PKCE, then dumps
//     tools/list and a sample recent-activities tools/call so the real tool names
//     and payload shapes can be frozen into api/__tests__/fixtures/coros/.
//     Nothing is persisted; tokens live and die with the process.
//
//   node scripts/coros-spike.mjs register https://<your-domain>/api/provider-callback
//     Mints the PRODUCTION client: registers "Apex Training" with COROS via DCR
//     using the given callback URL and prints the two env lines to paste into
//     Vercel. One-time per deployment domain; public client, no secret — PKCE
//     carries the proof, so the client_id is not sensitive.
//
// Run from the repo root — the path is relative.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const MCP_ENDPOINT = 'https://mcp.coros.com/mcp';
const CALLBACK_PORT = 8787;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

const mode = process.argv[2] ?? 'discover';

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function discoverAuthServer() {
  const init = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'apex-spike', version: '0.0.1' } },
    }),
  });
  const www = init.headers.get('www-authenticate') ?? '';
  const resourceMetaUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1]
    ?? new URL('/.well-known/oauth-protected-resource', MCP_ENDPOINT).href;
  const prm = await fetchJson(resourceMetaUrl, { headers: { accept: 'application/json' } });
  const asBase = prm.json?.authorization_servers?.[0] ?? new URL(MCP_ENDPOINT).origin;
  const asMeta = await fetchJson(new URL('/.well-known/oauth-authorization-server', asBase), {
    headers: { accept: 'application/json' },
  });
  return { initStatus: init.status, wwwAuthenticate: www, resource: prm.json?.resource ?? asBase, asMeta: asMeta.json };
}

async function discover() {
  const found = await discoverAuthServer();
  console.log(JSON.stringify(found, null, 2));
  if (!found.asMeta?.registration_endpoint) {
    console.error('No registration_endpoint — DCR unavailable.');
    return;
  }
  const reg = await fetchJson(found.asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Apex Training (spike probe)',
      redirect_uris: [CALLBACK_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  console.log('DCR probe:', reg.status, JSON.stringify(reg.json, null, 2));
}

function b64url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function login() {
  const { asMeta, resource } = await discoverAuthServer();
  const reg = await fetchJson(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Apex Training (local spike)',
      redirect_uris: [CALLBACK_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const clientId = reg.json?.client_id;
  if (!clientId) throw new Error(`DCR failed: ${reg.status} ${reg.text}`);

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK_URL,
    scope: 'openid mcp.tools offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  }).toString();

  console.log('\nOpen this URL in a browser and sign in to COROS:\n');
  console.log(authUrl.href, '\n');

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, CALLBACK_URL);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h3>Connected - return to the terminal.</h3>');
      server.close();
      if (url.searchParams.get('state') !== state) reject(new Error('state mismatch'));
      else if (url.searchParams.get('error')) reject(new Error(url.searchParams.get('error')));
      else resolve(url.searchParams.get('code'));
    }).listen(CALLBACK_PORT);
  });

  const token = await fetchJson(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URL,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  if (!token.json?.access_token) throw new Error(`token exchange failed: ${token.status} ${token.text}`);
  console.log('Token response keys:', Object.keys(token.json).join(', '),
    '· expires_in:', token.json.expires_in, '· refresh_token present:', Boolean(token.json.refresh_token));

  const bearer = token.json.access_token;
  let nextId = 1;
  let sessionId = null;

  async function rpc(method, params) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    // Notifications carry no id and get NO JSON-RPC reply (typically an
    // empty 202) — parsing that empty body is what crashed the first run.
    const isNotification = method.startsWith('notifications/');
    const res = await fetch(MCP_ENDPOINT, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(isNotification ? {} : { id: nextId++ }),
        method,
        ...(params ? { params } : {}),
      }),
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    if (isNotification) return null;
    const text = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          const msg = JSON.parse(line.slice(5).trim());
          if ('result' in msg || 'error' in msg) return msg;
        }
      }
      throw new Error(`no JSON-RPC response in SSE body: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text);
  }

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'apex-training-spike', version: '0.0.1' },
  });
  console.log('\ninitialize →', JSON.stringify(init.result?.serverInfo ?? init.error));
  await rpc('notifications/initialized');

  const tools = await rpc('tools/list', {});
  console.log('\n=== tools/list (freeze into api/__tests__/fixtures/coros/tools-list.json) ===\n');
  console.log(JSON.stringify(tools.result ?? tools.error, null, 2));

  // Real tool contract (fixtures/coros/tools-list.json): querySportRecords
  // takes yyyyMMdd strings with every nullable filter listed in `required`;
  // getActivityDetail needs labelId + sportType from a records entry.
  const yyyymmdd = d => d.toISOString().slice(0, 10).replaceAll('-', '');
  const records = await rpc('tools/call', {
    name: 'querySportRecords',
    arguments: {
      startDate: yyyymmdd(new Date(Date.now() - 30 * 86_400_000)),
      endDate: yyyymmdd(new Date()),
      sportTypeCodes: null,
      minDistanceKm: null, maxDistanceKm: null,
      minDurationMinutes: null, maxDurationMinutes: null,
      maxAveragePace: null, locationKeyword: null, limit: 100,
    },
  });
  console.log('\n=== querySportRecords, last 30 days (freeze into fixtures/coros/sport-records.json) ===\n');
  const recordsPayload = records.result ?? records.error;
  console.log(JSON.stringify(recordsPayload, null, 2).slice(0, 20000));

  // Chase the first record's detail so the HR/pace/elevation payload shape
  // gets captured too.
  const recordsText = recordsPayload?.structuredContent
    ?? (() => { try { return JSON.parse(recordsPayload?.content?.[0]?.text ?? ''); } catch { return null; } })();
  const flat = JSON.stringify(recordsText ?? recordsPayload ?? {});
  // The records payload is formatted text ("LabelId: 4794… | SportType: 402"),
  // so match that form first and the JSON-key form as a fallback.
  const labelId = /LabelId:\s*([\w-]+)/.exec(flat)?.[1]
    ?? /"labelId"\s*:\s*"?([\w-]+)"?/.exec(flat)?.[1];
  const sportType = /SportType:\s*(\d+)/.exec(flat)?.[1]
    ?? /"sportType"\s*:\s*(\d+)/.exec(flat)?.[1];
  if (labelId && sportType) {
    const detail = await rpc('tools/call', {
      name: 'getActivityDetail',
      arguments: { labelId, sportType: Number(sportType) },
    });
    console.log(`\n=== getActivityDetail ${labelId}/${sportType} (freeze into fixtures/coros/activity-detail.json) ===\n`);
    console.log(JSON.stringify(detail.result ?? detail.error, null, 2).slice(0, 20000));

    // FIT streams path: URL tool → download → sanity-check the header.
    // (Counts one file against COROS's daily FIT limit.)
    const fitUrls = await rpc('tools/call', {
      name: 'queryActivityFitFileDownloadUrls',
      arguments: { labelId, sportType: Number(sportType), limit: 1 },
    });
    const fitFlat = JSON.stringify(fitUrls.result ?? fitUrls.error ?? {});
    console.log(`\n=== queryActivityFitFileDownloadUrls ${labelId} ===\n`, fitFlat.slice(0, 2000));
    const fitUrl = /https:\\?\/\\?\/[^\s"'<>\\)\]]+/.exec(fitFlat)?.[0]?.replaceAll('\\/', '/');
    if (fitUrl) {
      const res = await fetch(fitUrl);
      const buf = new Uint8Array(await res.arrayBuffer());
      // Bytes 8-11 of a FIT header spell ".FIT".
      const magic = String.fromCharCode(...buf.slice(8, 12));
      console.log(`\nFIT download: http ${res.status}, ${buf.byteLength} bytes, magic "${magic}" ${magic === '.FIT' ? '✓' : '✗ NOT A FIT FILE'}`);
    } else {
      console.log('\nNo download URL found in the FIT-URLs payload.');
    }
  } else {
    console.log('\nNo labelId/sportType found in the records payload — no activities in the last 30 days?');
  }
}

async function register(redirectUri) {
  if (!/^https:\/\/.+\/api\/provider-callback$/.test(redirectUri ?? '')) {
    console.error('usage: coros-spike.mjs register https://<your-domain>/api/provider-callback');
    process.exit(1);
  }
  const { asMeta } = await discoverAuthServer();
  if (!asMeta?.registration_endpoint) throw new Error('DCR unavailable — no registration_endpoint');
  const reg = await fetchJson(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Apex Training',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!reg.json?.client_id) throw new Error(`registration failed: ${reg.status} ${reg.text}`);
  console.log('Registered. Set these in Vercel (Project → Settings → Environment Variables), then redeploy:\n');
  console.log(`COROS_CLIENT_ID=${reg.json.client_id}`);
  console.log(`COROS_REDIRECT_URI=${redirectUri}`);
}

if (mode === 'discover') await discover();
else if (mode === 'login') await login();
else if (mode === 'register') await register(process.argv[3]);
else { console.error('usage: coros-spike.mjs [discover|login|register <redirect-uri>]'); process.exit(1); }
