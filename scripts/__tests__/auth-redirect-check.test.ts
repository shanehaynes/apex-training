import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The sign-up assertions of scripts/auth-redirect-check.sh (issue #210), driven
// against a stub GoTrue rather than production: the point of the check is that
// it refuses to call a signup "proved closed" on anything but the real
// refusal, and that is exactly what cannot be exercised against a project that
// is correctly configured.
//
// APEX_SUPABASE_URL and APEX_PROD_URL are two separate stubs on purpose, so a
// check that compared the wrong pair of origins could not pass by accident.

const script = fileURLToPath(new URL('../auth-redirect-check.sh', import.meta.url));

const SETTINGS_OK = {
  external: { email: true, phone: false, google: false, anonymous_users: false },
  disable_signup: true,
  mailer_autoconfirm: false,
  phone_autoconfirm: false,
  saml_enabled: false,
  passkeys_enabled: false,
};

const REFUSAL = { status: 422, body: { code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' } };

type SignupReply = { status: number; body: unknown };

const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

/** A stub project: GoTrue's three endpoints, plus the public origin it points at. */
async function stubProject(opts: { settings?: unknown; signup?: SignupReply } = {}) {
  const signupPosts: unknown[] = [];
  const prod = await listen((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>'));

  const supabase = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Everything GoTrue serves under /auth/v1 needs the anon key.
    if (url.pathname !== '/auth/v1/verify' && !req.headers.apikey) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'No API key found in request' }));
      return;
    }
    if (url.pathname === '/auth/v1/verify') {
      // A correctly allow-listed project: whatever redirect_to is asked for is
      // honoured, and the Site URL is the public origin.
      res.writeHead(302, { location: url.searchParams.get('redirect_to') ?? prod }).end();
      return;
    }
    if (url.pathname === '/auth/v1/settings') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(opts.settings ?? SETTINGS_OK));
      return;
    }
    if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        signupPosts.push(JSON.parse(raw || '{}'));
        const reply = opts.signup ?? REFUSAL;
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      });
      return;
    }
    res.writeHead(404).end();
  });

  return { prod, supabase, signupPosts };
}

// spawn, not spawnSync: the stubs live in this process, and a synchronous
// child would block the event loop that has to answer their requests.
function run(env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // VITE_* is stripped so the runner's own environment cannot hand the script
  // a key for a project it is not probing.
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('VITE_') || k.startsWith('APEX_')) delete base[k];
  const child = spawn('bash', [script], { env: { ...base, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
}

describe('auth-redirect-check.sh — sign-up is disabled (#210)', () => {
  it('passes only on the signup_disabled refusal, and sends no password', async () => {
    const { prod, supabase, signupPosts } = await stubProject();
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('✓ disable_signup is true');
    expect(res.stdout).toContain('✓ POST /auth/v1/signup is refused: 422 signup_disabled');
    expect(res.stdout).toContain('✓ email is the only enabled auth provider');
    expect(res.stdout).toContain('sign-up is closed');

    // An address (so GoTrue's anonymous-signup path is unreachable) and no
    // password (so no account can be created even if the toggle were off).
    expect(signupPosts).toHaveLength(1);
    const body = signupPosts[0] as Record<string, unknown>;
    expect(String(body.email)).toMatch(/^apex-signup-probe-.*@example\.invalid$/);
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('phone');
  });

  it('fails without posting anything when the settings say sign-up is open', async () => {
    const { prod, supabase, signupPosts } = await stubProject({
      settings: { ...SETTINGS_OK, disable_signup: false },
    });
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('ANYONE CAN CREATE AN ACCOUNT');
    expect(res.stderr).toContain('No signup request was sent');
    expect(signupPosts).toHaveLength(0);
  });

  it('fails loudly if a signup ever completes, and names the user to delete', async () => {
    const { prod, supabase } = await stubProject({
      signup: { status: 200, body: { id: '00000000-0000-0000-0000-000000000000', email: 'probe@example.invalid' } },
    });
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('CREATED SOMETHING');
    expect(res.stderr).toContain('Authentication → Users');
  });

  it('fails on any other answer, including a 422 that is not the refusal', async () => {
    const { prod, supabase } = await stubProject({
      signup: { status: 422, body: { code: 422, error_code: 'validation_failed', msg: 'Signup requires a valid password' } },
    });
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not 422 signup_disabled');
  });

  it('accepts an older GoTrue that sends the message without an error_code', async () => {
    const { prod, supabase } = await stubProject({
      signup: { status: 422, body: { code: 422, msg: 'Signups not allowed for this instance' } },
    });
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('✓ POST /auth/v1/signup is refused');
  });

  it('fails when a pinned dashboard setting drifts', async () => {
    const { prod, supabase } = await stubProject({ settings: { ...SETTINGS_OK, mailer_autoconfirm: true } });
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('mailer_autoconfirm is true, pinned at false');
  });

  it('fails when a second auth provider — or anonymous sign-in — is enabled', async () => {
    const withGoogle = await stubProject({
      settings: { ...SETTINGS_OK, external: { ...SETTINGS_OK.external, google: true } },
    });
    const google = await run({
      APEX_PROD_URL: withGoogle.prod,
      APEX_SUPABASE_URL: withGoogle.supabase,
      APEX_SUPABASE_ANON_KEY: 'anon-test-key',
    });
    expect(google.status).toBe(1);
    expect(google.stderr).toContain('enabled auth providers: email google');

    // anonymous_users self-provisions accounts whatever disable_signup says.
    const anon = await stubProject({
      settings: { ...SETTINGS_OK, external: { ...SETTINGS_OK.external, anonymous_users: true } },
    });
    const res = await run({
      APEX_PROD_URL: anon.prod,
      APEX_SUPABASE_URL: anon.supabase,
      APEX_SUPABASE_ANON_KEY: 'anon-test-key',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('anonymous_users');
  });

  it('says so and stays green — not silently green — when it has no anon key', async () => {
    // No APEX_SUPABASE_ANON_KEY, and any .env.local on this machine describes a
    // different project than the stub, so the key resolution must decline it.
    const { prod, supabase, signupPosts } = await stubProject();
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('Sign-up NOT verified this run');
    expect(res.stdout).toContain('sign-up NOT verified');
    expect(res.stdout).not.toContain('sign-up is closed');
    expect(signupPosts).toHaveLength(0);
  });

  it('reports the settings it cannot read rather than implying it checked them', async () => {
    const { prod, supabase } = await stubProject();
    const res = await run({ APEX_PROD_URL: prod, APEX_SUPABASE_URL: supabase, APEX_SUPABASE_ANON_KEY: 'anon-test-key' });

    expect(res.stdout).toContain('not readable with the anon key');
    expect(res.stdout).toMatch(/password minimum length[\s\S]*leaked-password protection, MFA/);
  });
});
