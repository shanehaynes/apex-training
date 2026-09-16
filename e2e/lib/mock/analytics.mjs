// The analytics endpoints, mocked for the driven profile.
//
// Since #152 the web reads tiles and computes them through the API, and the
// analytics provider is mounted app-wide (App.tsx) — so EVERY mock spec
// issues `GET /api/analytics-tiles` on load, not just the analytics ones.
// The intercept layer therefore has to answer these three routes properly
// rather than falling through to its `{ ok: true }` catch-all.
//
// Playwright's loader resolves these TS modules, so the stub runs the app's
// OWN pure functions — `specFromDraft`, `draftFromSpec`, `computeTile` — over
// a fabricated input set. There is no second implementation of draft→spec or
// of the aggregation to drift from the real server, and a refusal a spec
// asserts on (a grade scale, a blank title) is the real text, not a copy.
//
// Tile state is per BrowserContext (the WeakMap below), so a save in one
// spec is invisible to another and the parallel mock run stays deterministic.

import { computeTile } from '../../../src/lib/analytics/engine.ts';
import { draftFromSpec, specFromDraft } from '../../../src/lib/analytics/draft.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

const text = (route, body, status) =>
  route.fulfill({ status, contentType: 'text/plain', headers: CORS, body });

/** Mirrors api/_lib/handlers/analyticsCompute.ts. */
const MAX_SPECS = 24;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Mirrors api/_lib/allowlist.ts EVENT_ID_PATTERN closely enough to catch junk. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ─── The fabricated history every computed tile aggregates ───────────────────
// Dated around the pinned mock clock (2026-09-07, playwright.config.ts) so a
// rolling 90-day tile — the builder's default range — lands on top of it:
// four weeks of runs, lifts and climbing sessions through August and early
// September. Small on purpose; it exists to make charts draw real points and
// the picker options non-empty, not to model a training year.

const EVENTS = [
  ['evt-run', { title: 'Morning run', type: 'cardio', sport: 'running' }],
  ['evt-lift', { title: 'Upper body', type: 'weights', sport: null }],
  ['evt-climb', { title: 'Gym session', type: 'climbing', sport: 'climbing' }],
  ['evt-soccer', { title: 'Soccer night', type: 'cardio', sport: 'other' }],
];

/** definition_id → category: what identifies pitch rows and fills the category picker. */
const CATEGORIES = [
  ['def-cardio', 'cardio'],
  ['def-climbing', 'climbing'],
  ['def-strength', 'strength'],
];

const RUN_DATES = ['2026-08-12', '2026-08-19', '2026-08-26', '2026-09-02'];
const LIFT_DATES = ['2026-08-13', '2026-08-20', '2026-08-27', '2026-09-03'];
const CLIMB_DATES = ['2026-08-15', '2026-08-29', '2026-09-05'];

const completion = (eventId, date, type, title, minutes) => ({
  event_id: eventId, event_date: date, event_type: type, event_title: title,
  duration_minutes: minutes, is_completed: true,
  completed_at: `${date}T12:00:00Z`, updated_at: `${date}T12:00:00Z`,
});

const cardioLog = (date, miles, feet, hr) => ({
  event_id: 'evt-run', event_date: date, section: 'exercise',
  exercise_id: 'run', exercise_name: 'Run', definition_id: 'def-cardio',
  duration_minutes: 45, distance: `${miles} mi`, elevation_gain: `${feet} ft`,
  avg_heart_rate: hr, is_autofilled: false,
});

const setLog = (eventId, date, name, definitionId, setNumber, weight, reps) => ({
  event_id: eventId, event_date: date, section: 'exercise',
  exercise_id: name.toLowerCase().replaceAll(' ', '-'), exercise_name: name,
  definition_id: definitionId, set_number: setNumber,
  planned_weight: null, planned_reps: null, planned_duration: null,
  actual_weight: weight, actual_reps: reps, actual_duration: null,
  is_autofilled: false,
});

const meal = (date, id, type, kcal, protein) => ({
  id, title: 'Meal', date, time: null, meal_type: type,
  calories: kcal, protein_g: protein, carbs_g: 60, fiber_g: 8, sugar_g: 12,
  fat_total_g: 20, fat_saturated_g: 6, fat_trans_g: 0, alcohol_g: null,
  notes: '', created_at: `${date}T12:00:00Z`, updated_at: `${date}T12:00:00Z`,
});

/** Everything the engine needs, in the shape loadAnalyticsInputs returns. */
export const MOCK_ANALYTICS_INPUTS = {
  completions: [
    ...RUN_DATES.map(d => completion('evt-run', d, 'cardio', 'Morning run', 45)),
    ...LIFT_DATES.map(d => completion('evt-lift', d, 'weights', 'Upper body', 60)),
    ...CLIMB_DATES.map(d => completion('evt-climb', d, 'climbing', 'Gym session', 90)),
    completion('evt-soccer', '2026-09-01', 'cardio', 'Soccer night', 60),
  ],
  sessions: LIFT_DATES.map(date => ({
    id: `session-${date}`, event_id: 'evt-lift', event_date: date,
    started_at: `${date}T10:00:00Z`, finished_at: `${date}T11:00:00Z`,
    total_duration_seconds: 3600, coach_summary: null, updated_at: `${date}T11:00:00Z`,
    template_id: null, score_type: null, score_time_seconds: null, score_rounds: null, score_reps: null,
  })),
  setLogs: [
    ...LIFT_DATES.flatMap(date => [1, 2, 3].map(n =>
      setLog('evt-lift', date, 'Bench Press', 'def-strength', n, String(130 + n * 5), '8'))),
    // Pitch rows: category 'climbing', the grade text in actual_weight.
    ...CLIMB_DATES.flatMap(date => ['5.10a', '5.10d', '5.11a'].map((grade, i) =>
      setLog('evt-climb', date, 'Lead climb', 'def-climbing', i + 1, grade, null))),
  ],
  cardioLogs: [
    cardioLog('2026-08-12', 5, 300, 148),
    cardioLog('2026-08-19', 6, 350, 151),
    cardioLog('2026-08-26', 7, 420, 149),
    cardioLog('2026-09-02', 8, 500, 153),
  ],
  meals: [
    meal('2026-09-02', 'meal-1', 'breakfast', 620, 38),
    meal('2026-09-02', 'meal-2', 'dinner', 900, 55),
    meal('2026-09-03', 'meal-3', 'lunch', 750, 44),
  ],
  // No HR streams: the driven profile has neither max_hr nor threshold_hr, so
  // an hr-zone tile answers the engine's "set one in your profile" problem —
  // which is the honest state for this profile, and the same one the real
  // server would compute.
  zoneActivities: [],
  categories: new Map(CATEGORIES),
  events: new Map(EVENTS),
};

/** What the builder's pickers offer, as GET serves it (distinct + sorted). */
export const MOCK_ANALYTICS_OPTIONS = {
  categories: [...new Set(CATEGORIES.map(([, c]) => c))].sort(),
  otherWorkoutTitles: [...new Set(
    EVENTS.filter(([, e]) => e.sport === 'other').map(([, e]) => e.title.trim()).filter(Boolean),
  )].sort(),
};

const DEFAULT_LAYOUT = { x: 0, y: 0, w: 6, h: 4 };

const layoutFrom = (raw) => ({
  x: Number.isInteger(raw?.x) ? raw.x : DEFAULT_LAYOUT.x,
  y: Number.isInteger(raw?.y) ? raw.y : DEFAULT_LAYOUT.y,
  w: Number.isInteger(raw?.w) ? raw.w : DEFAULT_LAYOUT.w,
  h: Number.isInteger(raw?.h) ? raw.h : DEFAULT_LAYOUT.h,
});

/** The compute context: the request's today, no active block, no HR settings. */
const contextFor = today => ({ todayIso: today, activeBlock: null, hr: { maxHr: null, thresholdHr: null } });

function computeSlot(slot, today) {
  if (slot && typeof slot === 'object' && 'problem' in slot) return { ok: false, problem: slot.problem };
  return computeTile(slot, MOCK_ANALYTICS_INPUTS, contextFor(today));
}

function slotFromDraft(draft) {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return { problem: 'draft must be an object' };
  try {
    const built = specFromDraft(draft);
    return 'error' in built ? { problem: built.error } : built.spec;
  } catch {
    return { problem: 'draft is not a chart draft' };
  }
}

/**
 * One tile store per BrowserContext. Specs that want saved tiles still stub
 * the GET with their own page.route (which outranks the context route); this
 * is what makes a tile SAVED in a spec come back on the next read.
 */
class AnalyticsStore {
  constructor() {
    /** @type {Map<string, object>} id → the tile view GET serves. */
    this.tiles = new Map();
  }

  /** GET/POST/PATCH/DELETE /api/analytics-tiles. */
  tilesRoute(route, req) {
    const method = req.method();

    if (method === 'GET') {
      const tiles = [...this.tiles.values()].sort(
        (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
      );
      return json(route, { tiles, options: MOCK_ANALYTICS_OPTIONS });
    }

    if (method === 'POST') {
      const body = req.postDataJSON() ?? {};
      if (typeof body.id !== 'string' || !ID_RE.test(body.id)) {
        return text(route, 'Missing or invalid tile id', 400);
      }
      if ('draft' in body && 'spec' in body) {
        return text(route, 'Send either spec or draft, not both', 400);
      }
      // The spec body is still accepted by the real server (a native client
      // could send one), but the WEB stopped sending it in #152. Fail loudly
      // rather than quietly saving: a spec arriving here means the switch
      // regressed, and a green suite would be the wrong answer.
      if ('spec' in body) {
        return text(route, 'mock: the web must save a draft, not a spec (#152)', 400);
      }
      const draft = body.draft;
      if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
        return text(route, 'draft must be an object', 400);
      }
      // Order matters and is the server's, not the old client's: the blank
      // title is checked BEFORE the draft would be built.
      if (typeof draft.title !== 'string' || !draft.title.trim()) {
        return json(route, { ok: false, problem: 'Give the tile a title' });
      }
      let built;
      try {
        built = specFromDraft(draft);
      } catch {
        return text(route, 'draft is not a chart draft', 400);
      }
      if ('error' in built) return json(route, { ok: false, problem: built.error });

      const tile = {
        id: body.id,
        title: built.spec.title,
        spec: built.spec,
        draft: draftFromSpec(built.spec),
        layout: layoutFrom(body.layout),
        updatedAt: '2026-09-07T08:00:00.000Z',
      };
      this.tiles.set(tile.id, tile);
      return json(route, { ok: true, id: tile.id, tile });
    }

    if (method === 'PATCH') {
      const { layouts } = req.postDataJSON() ?? {};
      for (const entry of Array.isArray(layouts) ? layouts : []) {
        const tile = this.tiles.get(entry?.id);
        if (tile) tile.layout = layoutFrom(entry);
      }
      return json(route, { ok: true });
    }

    if (method === 'DELETE') {
      const id = new URL(req.url()).searchParams.get('id');
      if (!id) return text(route, 'Missing id', 400);
      this.tiles.delete(id);
      return json(route, { id });
    }

    return text(route, 'Method not allowed', 405);
  }

  /** POST /api/analytics-compute. */
  computeRoute(route, req) {
    if (req.method() !== 'POST') return text(route, 'Method not allowed', 405);
    const body = req.postDataJSON() ?? {};
    const hasSpecs = body.specs !== undefined;
    const hasDrafts = body.drafts !== undefined;
    const batch = hasSpecs ? body.specs : body.drafts;
    if (hasSpecs === hasDrafts || !Array.isArray(batch) || batch.length < 1 || batch.length > MAX_SPECS) {
      return text(route, `specs or drafts must be an array of 1-${MAX_SPECS}`, 400);
    }
    if (typeof body.today !== 'string' || !DATE_RE.test(body.today)) {
      return text(route, 'today must be a YYYY-MM-DD date', 400);
    }
    const slots = hasSpecs ? batch : batch.map(slotFromDraft);
    return json(route, { today: body.today, tiles: slots.map(slot => computeSlot(slot, body.today)) });
  }
}

const stores = new WeakMap();

/** The analytics stub for one BrowserContext, created on first use. */
export function analyticsMock(context) {
  let store = stores.get(context);
  if (!store) {
    store = new AnalyticsStore();
    stores.set(context, store);
  }
  return store;
}
