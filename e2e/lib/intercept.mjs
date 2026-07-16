// Request interception for the mock profile.
//
// SAFETY: when .env.local points the app at a real Supabase project, a live
// browser session could write (and cancel would DELETE) real rows. This layer
// answers every request that could write — /api/* and all non-GET supabase
// calls — with stubs, so nothing clicked in a driven session ever mutates
// real data. Tracker log reads are stubbed with fabricated history so the
// "prev" column renders deterministically. Calendar event reads pass through
// with the anon key swapped back in for the fake JWT.
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

/**
 * Install the mock-profile stubs on a BrowserContext.
 * `profile` is the stubbed own-profile row (see driverProfile in session.mjs);
 * `anonKey` re-authorizes passthrough REST reads (null in offline mode).
 */
export async function installIntercept(context, { anonKey = null, profile } = {}) {
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

    // Tracker log reads: fabricate prior sessions so the prev column and the
    // library history views render. NOTE: query strings encode spaces as '+',
    // which decodeURIComponent does NOT translate — swap them first.
    if (url.includes('workout_set_logs')) {
      const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
      // Library detail history: exercise_name filter without the tracker's
      // event_date=lt. bound. Three sessions of growing holds so the PR card,
      // trend chart, and session list all render.
      if (decoded.includes('exercise_name=in.') && !decoded.includes('event_date=lt.')) {
        const m = decoded.match(/exercise_name=in\.\(([^)]*)\)/);
        const name = m ? m[1].split(',')[0].replace(/^"|"$/g, '').trim() : 'Exercise';
        return json(route, ['2000-01-01', '2000-01-08', '2000-01-15'].map((event_date, i) => ({
          event_id: `driver-hist-${i}`, event_date, section: 'exercise',
          exercise_id: 'hist', exercise_name: name, set_number: 1,
          planned_weight: null, planned_reps: null, planned_duration: null,
          actual_weight: null, actual_reps: null, actual_duration: `${45 + i * 15}s`,
          is_autofilled: false,
        })));
      }
      if (decoded.includes('event_date=lt.')) {
        const m = decoded.match(/exercise_name=in\.\(([^)]*)\)/);
        const names = m ? m[1].split(',').map(s => s.replace(/^"|"$/g, '').trim()) : [];
        return json(route, names.flatMap((name, i) => [1, 2].map(setNumber => ({
          event_id: 'driver-prev', event_date: '2000-01-01', section: 'exercise',
          exercise_id: `prev-${i}`, exercise_name: name, set_number: setNumber,
          planned_weight: null, planned_reps: null, planned_duration: null,
          actual_weight: null, actual_reps: null, actual_duration: setNumber === 1 ? '0:45' : '1:00',
          is_autofilled: false,
        }))));
      }
      return json(route, []);
    }
    if (url.includes('workout_cardio_logs')) return json(route, []);

    // Catch-all: no other write escapes to the real project.
    if (req.method() !== 'GET') return json(route, []);

    // Passthrough REST reads: the fabricated session attaches its fake JWT,
    // which the real PostgREST would reject wholesale — swap the anon key
    // back in. (After the phase10 lockdown these reads return zero rows and
    // the app falls back to the bundled seed — still deterministic.)
    if (anonKey) {
      return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${anonKey}` } });
    }
    return route.continue();
  });
}
