// Request interception for the mock profile.
//
// SAFETY: when .env.local points the app at a real Supabase project, a live
// browser session could write (and cancel would DELETE) real rows. This layer
// answers every request that could write — /api/* and all non-GET supabase
// calls — with stubs, so nothing clicked in a driven session ever mutates
// real data. Tracker log reads are stubbed with fabricated history so the
// shadow-fill ghosts render deterministically. Schedule reads (events,
// exceptions, definitions) are stubbed so the calendar always renders the
// bundled seed, whatever project .env.local points at.
//
// Fulfilled responses bypass the server, so the browser enforces CORS against
// the stub itself — every stub needs these headers, and OPTIONS preflights
// need an explicit 204.

import { DRIVER_USER, fabricatedSession } from './session.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

// Parse `exercise_name=in.("A","B (variant)",C)` from a decoded query string.
// PostgREST quotes names containing reserved chars — parens, commas — so a
// naive [^)]* match truncates at the first inner paren and drops most names.
function parseNameFilter(decoded) {
  const m = decoded.match(/exercise_name=in\.\((.*?)\)(?=&|$)/);
  if (!m) return [];
  return (m[1].match(/"[^"]*"|[^,]+/g) ?? []).map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean);
}

/**
 * True for the one console error a mock session produces on purpose: the
 * workout_events stub below answers 503 to force the bundled-seed fallback,
 * and Chromium logs every non-2xx resource load as a console error. The
 * error watchers (fixtures.ts, drive.mjs) skip exactly this message.
 */
export function isExpectedConsoleError(msg) {
  return (msg.location()?.url ?? '').includes('/rest/v1/workout_events');
}

/**
 * Install the mock-profile stubs on a BrowserContext.
 * `profile` is the stubbed own-profile row (see driverProfile in session.mjs);
 * `anonKey` re-authorizes passthrough REST reads (null in offline mode).
 */
export async function installIntercept(context, { anonKey = null, profile } = {}) {
  // The design tokens @import Google Fonts — the one external fetch in an
  // otherwise hermetic suite, and a real flake source: Claude remote-sandbox
  // egress proxies reset it, which failed every spec via the console-error
  // fixture. Fulfill with empty CSS (the UI falls back to system fonts);
  // gstatic would only be fetched by rules in that CSS, but stub it too so
  // no font request can ever leave the suite.
  await context.route('https://fonts.googleapis.com/**', route =>
    route.fulfill({ status: 200, contentType: 'text/css', headers: CORS, body: '' }));
  await context.route('https://fonts.gstatic.com/**', route =>
    route.fulfill({ status: 200, headers: CORS, body: '' }));

  // Vercel functions don't run under `vite dev` (they'd 404 anyway) and the
  // real ones write to Supabase — stub the whole surface.
  await context.route('**/api/**', route => {
    const req = route.request();
    const url = req.url();

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    if (url.includes('/api/workout-sessions')) {
      return json(route, {
        session: {
          id: 'driver-session', event_id: 'x', event_date: '2000-01-01',
          started_at: new Date().toISOString(), finished_at: null,
          total_duration_seconds: null, updated_at: '',
        },
      });
    }
    // MCP connector tokens (profile section): empty list, and a fixed fake
    // token on mint so the one-time reveal UI renders.
    if (url.includes('/api/mcp-tokens')) {
      return json(route, req.method() === 'POST'
        ? { id: 'mock-token-1', token: 'apx_mock-token-not-real' }
        : { tokens: [] });
    }
    // Key status for the AI Coach: hasAnthropicKey=true keeps the coach UI
    // live (a false would swap in the setup prompt).
    if (url.includes('/api/profile')) {
      return json(route, req.method() === 'GET'
        ? { hasAnthropicKey: true, anthropicKeyLast4: 'abcd' }
        : { ok: true, hasAnthropicKey: true, anthropicKeyLast4: 'abcd' });
    }
    return json(route, { ok: true });
  });

  await context.route(/https:\/\/[^/]+\.supabase\.co\//, route => {
    const req = route.request();
    const url = req.url();

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    // Auth endpoints never reach the real project. getSession() is served
    // from localStorage, but token refresh / getUser / signout would 401 on
    // the fake JWT and bounce the app back to the login screen.
    if (url.includes('/auth/v1/')) {
      if (url.includes('/auth/v1/user')) return json(route, DRIVER_USER);
      if (url.includes('/auth/v1/logout')) return route.fulfill({ status: 204, headers: CORS });
      return json(route, fabricatedSession());
    }

    // Own-profile read (RLS-scoped in production; deterministic stub here).
    // .maybeSingle() asks PostgREST for a bare object via the Accept header —
    // answer in kind or supabase-js hands the app an array as `data`.
    if (url.includes('/rest/v1/profiles')) {
      const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
      return json(route, wantsObject ? profile : [profile]);
    }

    // Tracker log reads: fabricate prior sessions so shadow-fill ghosts and
    // the library history views render. NOTE: query strings encode spaces as
    // '+', which decodeURIComponent does NOT translate — swap them first.
    if (url.includes('workout_set_logs')) {
      const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
      // Library detail history: exercise_name filter without the tracker's
      // event_date=lt. bound. Three sessions of growing holds so the PR card,
      // trend chart, and session list all render.
      if (decoded.includes('exercise_name=in.') && !decoded.includes('event_date=lt.')) {
        const name = parseNameFilter(decoded)[0] ?? 'Exercise';
        return json(route, ['2000-01-01', '2000-01-08', '2000-01-15'].map((event_date, i) => ({
          event_id: `driver-hist-${i}`, event_date, section: 'exercise',
          exercise_id: 'hist', exercise_name: name, set_number: 1,
          planned_weight: null, planned_reps: null, planned_duration: null,
          actual_weight: null, actual_reps: null, actual_duration: `${45 + i * 15}s`,
          is_autofilled: false,
        })));
      }
      if (decoded.includes('event_date=lt.')) {
        const names = parseNameFilter(decoded);
        // Weight, reps, AND duration so every rendered input dimension gets a
        // ghost, whatever the exercise's planned fields are.
        return json(route, names.flatMap((name, i) => [1, 2].map(setNumber => ({
          event_id: 'driver-prev', event_date: '2000-01-01', section: 'exercise',
          exercise_id: `prev-${i}`, exercise_name: name, set_number: setNumber,
          planned_weight: null, planned_reps: null, planned_duration: null,
          actual_weight: setNumber === 1 ? '100' : '105', actual_reps: '8',
          actual_duration: setNumber === 1 ? '0:45' : '1:00',
          is_autofilled: false,
        }))));
      }
      return json(route, []);
    }
    if (url.includes('workout_cardio_logs')) return json(route, []);

    // Meals + favorites: deterministic empty lists (the add-meal spec
    // exercises the composer, not persisted rows).
    if (url.includes('/rest/v1/meals')) return json(route, []);
    if (url.includes('/rest/v1/meal_favorites')) return json(route, []);

    // Phase 19. Stubbed empty rather than passed through so the blocks
    // provider settles deterministically and the calendar specs don't see an
    // unhandled request on load. Block-specific specs override this.
    if (url.includes('training_blocks') || url.includes('/rest/v1/objectives')) return json(route, []);

    // Catch-all: no other write escapes to the real project.
    if (req.method() !== 'GET') return json(route, []);

    // Schedule reads never pass through. After the phase10 RLS lockdown the
    // real project answers these with 200 and zero rows for the driver user,
    // and ScheduleContext.loadEvents treats an empty 200 as a legitimately
    // empty calendar — it only falls back to the bundled seed on an *error*.
    // So answer workout_events with an error status to force that fallback
    // deterministically (Chromium logs the non-2xx load as a console error;
    // isExpectedConsoleError above lets the error watchers skip exactly it);
    // exceptions and definitions stub empty, matching offline mode (entries
    // render their embedded snapshots).
    if (url.includes('workout_events')) {
      return route.fulfill({
        status: 503, contentType: 'application/json', headers: CORS,
        body: JSON.stringify({ message: 'mock profile: forced bundled-seed fallback' }),
      });
    }
    if (url.includes('recurring_exceptions') || url.includes('exercise_definitions')) {
      return json(route, []);
    }

    // Passthrough REST reads (workout_completions, workout_sessions): the
    // fabricated session attaches its fake JWT, which the real PostgREST
    // would reject wholesale — swap the anon key back in. Post-phase10 RLS
    // these return 200 with zero rows, which is both deterministic and the
    // correct state (nothing completed, no open session).
    if (anonKey) {
      return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${anonKey}` } });
    }
    return route.continue();
  });
}
