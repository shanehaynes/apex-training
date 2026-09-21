import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../_lib/app';

// vercel.json is the only routing and response-header config the deployment
// has, and nothing validates it beyond "is it JSON". Every mistake it can hold
// is silent until production: a rewrite that swallows /api/* returns
// index.html with a 200 for every API call (it did — the `[...path].ts`
// catch-all was blackholed when the SPA rewrite matched `/api/*`); a cron
// pointing at a route that no longer exists is a nightly 404 that nobody is
// emailed about; a discovery rewrite with the wrong `kind` makes every MCP
// client's connect flow fail at the first step; a function whose maxDuration
// key doesn't match its filename runs at the account default and is killed
// mid-stream. This test reads the file and pins each of those, plus the
// response headers the site ships with.
//
// The headers are the baseline set — HSTS, nosniff, a frame policy (the OAuth
// consent page at /connect is a clickjacking target), a referrer policy, and
// a Permissions-Policy that turns off sensors the app never asks for. What is
// deliberately NOT here, so nobody re-litigates it from scratch:
//
// - Content-Security-Policy. Vite + Tailwind v4 + framer-motion need
//   'unsafe-inline' styles, and connect-src differs per environment (the
//   Supabase project URL). A CSP is a separate, deliberate change with its own
//   report-only rollout — not a line in a headers block.
// - Cross-Origin-Opener-Policy / -Embedder-Policy. The app has no popup flows
//   (password sign-in only, no window.open), so COOP would be harmless but
//   also pointless without COEP, and COEP demands CORP on every cross-origin
//   subresource, Google Fonts included. Nothing here uses SharedArrayBuffer.
// - `preload` on HSTS. Submitting to the browser preload list is a one-way
//   commitment for the whole domain; the owner opts in explicitly or not at all.
// - Cache-Control on /api/*. Handlers that care already set it, and they
//   disagree on purpose: calendar-feed is `private, max-age=900`, chat is
//   `no-cache`, oauth-metadata is `public, max-age=3600`. A blanket `no-store`
//   would either clobber those or be dead config, depending on a precedence
//   rule the Vercel docs leave unstated. Per-handler is the right layer.
// - Access-Control-Allow-Origin. The /.well-known documents are fetched
//   server-to-server by MCP clients, and nothing browser-side calls this API
//   cross-origin. A global CORS header would widen the surface for no caller.

interface VercelConfig {
  functions?: Record<string, { maxDuration?: number }>;
  rewrites: Array<{ source: string; destination: string }>;
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  crons: Array<{ path: string; schedule: string }>;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

// Vercel compiles `source` with path-to-regexp 6 (strict, case-sensitive).
// That package is only a transitive dependency here, so rather than import
// it this mirrors the two constructs vercel.json actually uses — a verbatim
// regex group like `((?!api/).*)` and a trailing `/:name*` — and throws on
// anything else. A throw is the right failure: a source this can't read is
// a source nobody has checked.
function sourceToRegExp(source: string): RegExp {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '(') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === '(') depth++;
        else if (source[j] === ')' && --depth === 0) break;
      }
      if (depth !== 0) throw new Error(`unbalanced group in vercel.json source ${source}`);
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ':') {
      const m = /^:[A-Za-z_]\w*\*$/.exec(source.slice(i));
      if (!m || out.at(-1) !== '/') {
        throw new Error(`unsupported parameter syntax in vercel.json source ${source}`);
      }
      out = `${out.slice(0, -1)}(?:/[^/]+)*`;
      i += m[0].length;
      continue;
    }
    if ('*+?'.includes(ch)) throw new Error(`unsupported modifier in vercel.json source ${source}`);
    out += /[.^$|[\]{}\\]/.test(ch) ? `\\${ch}` : ch;
    i++;
  }
  return new RegExp(`^${out}$`);
}

// First matching rewrite wins, as in Vercel's router.
function rewriteFor(path: string) {
  return config.rewrites.find(r => sourceToRegExp(r.source).test(path));
}

// Every root-level api/*.ts is its own function, and an unpinned one runs at
// whatever default the account happens to have — a number that cannot be read
// from this tree. A platform timeout on /api/chat closes the NDJSON socket
// mid-stream: no `done` line, the caller's own Anthropic key already billed.
// So each function pins its duration somewhere, and this pins the pinning.
//
// Vercel matches these keys as `key === fileName || minimatch(fileName, key)`
// (fs-detectors, getFunction), first match in insertion order winning. Both
// halves matter here: minimatch reads `[...path]` as a character class, so the
// catch-all can ONLY be configured by its exact literal path, and a glob key
// like `api/*.ts` would silently swallow every entry listed after it. Hence
// exact paths, and a test that keeps them exact.
describe('vercel.json functions', () => {
  // Root-level api/*.ts only — _lib/ is helpers behind the router, and
  // ci-guards.sh pins this set at four.
  const ROOT_FUNCTIONS = readdirSync(join(ROOT, 'api'))
    .filter(f => f.endsWith('.ts'))
    .sort();

  // 60s is the legacy (non-fluid) Hobby serverless maximum; with fluid compute
  // the Hobby ceiling is 300s. Nothing in the repo records which of the two
  // this project runs on, so every value stays inside the smaller one and is
  // valid either way. Raising the ceiling is a deliberate change that has to
  // confirm fluid compute is enabled first.
  const BOTH_PLANS_MAX = 60;

  it('keys only exact, existing root-level function paths', () => {
    const entries = Object.entries(config.functions ?? {});
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, cfg] of entries) {
      expect(key, 'keys are paths under api/').toMatch(/^api\//);
      const file = key.slice('api/'.length);
      expect(file, 'a glob key would shadow later entries').not.toMatch(/[*?]/);
      expect(ROOT_FUNCTIONS, `${key} is not a root-level api function`).toContain(file);
      expect(Number.isInteger(cfg.maxDuration), `${key} maxDuration is an integer`).toBe(true);
      expect(cfg.maxDuration, `${key} maxDuration`).toBeGreaterThan(0);
      expect(
        cfg.maxDuration,
        `${key} exceeds the duration valid on both fluid and legacy Hobby`,
      ).toBeLessThanOrEqual(BOTH_PLANS_MAX);
    }
  });

  it('leaves no function running at the unverified account default', () => {
    for (const file of ROOT_FUNCTIONS) {
      const inConfig = config.functions?.[`api/${file}`]?.maxDuration !== undefined;
      const inCode = /^export const maxDuration = \d+;$/m.test(
        readFileSync(join(ROOT, 'api', file), 'utf8'),
      );
      expect(inConfig || inCode, `api/${file} pins no maxDuration`).toBe(true);
      // Two sources of truth for one function is a silent precedence question.
      expect(inConfig && inCode, `api/${file} pins maxDuration twice`).toBe(false);
    }
  });

  // /api/coach-summary streams from inside the catch-all (_lib/app.ts →
  // handlers/coachSummary.ts), so cutting the catch-all shorter than chat
  // truncates the same kind of response chat's own budget was set for.
  it('never makes the catch-all shorter than chat', () => {
    const chat = config.functions?.['api/chat.ts']?.maxDuration;
    const catchAll = config.functions?.['api/[...path].ts']?.maxDuration;
    expect(chat, 'api/chat.ts has no maxDuration').toBeDefined();
    expect(catchAll, 'api/[...path].ts has no maxDuration').toBeDefined();
    expect(catchAll).toBeGreaterThanOrEqual(chat as number);
  });
});

describe('vercel.json rewrites', () => {
  it('sends SPA routes to index.html but never /api/*', () => {
    const spa = config.rewrites.filter(r => r.destination === '/index.html');
    expect(spa).toHaveLength(1);
    // The catch-all also matches /.well-known/*, so it must be ordered last.
    expect(config.rewrites.at(-1)).toBe(spa[0]);

    for (const path of ['/', '/profile', '/connect', '/workout/abc-123']) {
      expect(rewriteFor(path)?.destination, path).toBe('/index.html');
    }
    for (const path of ['/api/events', '/api/chat', '/api/oauth-metadata', '/api/calendar-feed']) {
      expect(rewriteFor(path), `${path} must fall through to its function`).toBeUndefined();
    }
  });

  // RFC 9728 puts protected-resource metadata at both the bare well-known
  // path and the path-suffixed form (/.well-known/oauth-protected-resource/
  // api/mcp for the resource https://host/api/mcp); RFC 8414 does the same
  // for the authorization server. The handler reads ?kind= to pick the
  // document (see _lib/handlers/oauthMetadata.ts), so the kind is load-bearing.
  it('routes every OAuth discovery path to oauth-metadata with the right kind', () => {
    expect(app.routes.some(r => r.path === '/api/oauth-metadata')).toBe(true);
    const discovery: Array<[prefix: string, kind: string]> = [
      ['/.well-known/oauth-protected-resource', 'resource'],
      ['/.well-known/oauth-authorization-server', 'server'],
    ];
    for (const [prefix, kind] of discovery) {
      for (const path of [prefix, `${prefix}/api/mcp`]) {
        expect(rewriteFor(path)?.destination, path).toBe(`/api/oauth-metadata?kind=${kind}`);
      }
    }
  });
});

describe('vercel.json crons', () => {
  // A cron target is either a standalone api/<name>.ts function or a path in
  // the Hono route table behind api/[...path].ts. Anything else is a 404 on a
  // schedule — Vercel records it, but the app never notices.
  it('schedules only paths that resolve to a real route', () => {
    expect(config.crons.length).toBeGreaterThan(0);
    for (const { path } of config.crons) {
      expect(path, 'cron paths live under /api/').toMatch(/^\/api\/[^/]+$/);
      const standalone = existsSync(join(ROOT, 'api', `${path.slice('/api/'.length)}.ts`));
      const routed = app.routes.some(r => r.path === path);
      expect(standalone || routed, `${path} has no function and no route`).toBe(true);
    }
  });
});

describe('vercel.json headers', () => {
  const REQUIRED: Record<string, string> = {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };

  // One path of every kind the deployment serves: the SPA shell, a client
  // route, the consent page, a hashed asset, standalone and routed functions,
  // and a rewritten discovery document. A header that misses any of these is
  // not a baseline.
  const EVERY_KIND_OF_PATH = [
    '/',
    '/profile',
    '/connect',
    '/assets/index-abc123.js',
    '/api/events',
    '/api/mcp',
    '/api/chat',
    '/api/calendar-feed',
    '/.well-known/oauth-protected-resource',
  ];

  function headersOn(path: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const rule of config.headers ?? []) {
      if (!sourceToRegExp(rule.source).test(path)) continue;
      for (const { key, value } of rule.headers) found.set(key.toLowerCase(), value);
    }
    return found;
  }

  it('ships the baseline security headers on every kind of path', () => {
    for (const path of EVERY_KIND_OF_PATH) {
      const found = headersOn(path);
      for (const [key, value] of Object.entries(REQUIRED)) {
        expect(found.get(key.toLowerCase()), `${key} on ${path}`).toBe(value);
      }
    }
  });

  it('leaves CORS to the handlers rather than opening it globally', () => {
    for (const rule of config.headers ?? []) {
      const cors = rule.headers.filter(h => h.key.toLowerCase().startsWith('access-control-'));
      expect(cors, `${rule.source} sets CORS headers`).toEqual([]);
    }
  });
});
