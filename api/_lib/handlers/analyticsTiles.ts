import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { pickAllowed, ANALYTICS_TILE_COLUMNS, EVENT_ID_PATTERN } from '../allowlist.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { AnalyticsTileRow, TablesInsert } from '../../../src/lib/db/types.js';
import { specProblem as deepSpecProblem, upgradeSpec, type ChartSpec } from '../../../src/lib/analytics/spec.js';
import { draftFromSpec, specFromDraft, type ChartDraft } from '../../../src/lib/analytics/draft.js';
import { DEFAULT_TILE_LAYOUT, rowToTile, tileToRow, type TileLayout } from '../../../src/lib/analytics/tiles.js';

// Analytics dashboard tiles (phase 35), served as /api/analytics-tiles by
// the consolidated router (_lib/app.ts). GET lists the caller's tiles (W9 —
// the native app reads through the API; the web still reads PostgREST under
// RLS); POST upserts one tile scoped to (user_id, id); PATCH commits grid
// layouts in batch (the debounced drag/resize write); DELETE removes a tile
// outright — nothing keys history on a tile id, so there is no archive state
// (unlike templates). No AI cap or mutation log: the coach has no tile tools
// in chat mode — the analytics coach edits an unsaved draft, and only the
// user's Save writes here.
//
// Two POST bodies. The web sends the spec it built client-side; a native
// client sends the builder's ChartDraft and the server runs the web's own
// specFromDraft (src/lib/analytics/draft.ts) — nothing about draft→spec
// exists in Swift (D-008). A draft that fails validation answers 200
// { ok:false, problem } with the same person-phrased text the web toasts,
// the /api/workout-draft convention, so the client keeps the message.
//
// The spec column is validated for shape (version, series count, size) and
// then deeply by specProblem (src/lib/analytics/spec.ts) — since W8 the
// server owns the contract, so a native client never validates a spec and
// the renderer's error tile is for rows that predate this check.

const MAX_SERIES = 8;
const MAX_SPEC_BYTES = 16_384;

function specShapeProblem(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return 'spec must be an object';
  const s = spec as Record<string, unknown>;
  if (s.version !== 1) return 'spec.version must be 1';
  if (typeof s.title !== 'string' || !s.title.trim()) return 'spec.title is required';
  if (!Array.isArray(s.series) || s.series.length < 1 || s.series.length > MAX_SERIES) {
    return `spec.series must be an array of 1-${MAX_SERIES}`;
  }
  if (JSON.stringify(s).length > MAX_SPEC_BYTES) return 'spec is too large';
  return null;
}

const isLayoutInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

function layoutProblem(row: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }): string | null {
  if (row.x !== undefined && !isLayoutInt(row.x, 11)) return 'x must be an integer in 0-11';
  if (row.y !== undefined && !isLayoutInt(row.y, 10_000)) return 'y must be a non-negative integer';
  if (row.w !== undefined && !(isLayoutInt(row.w, 12) && row.w >= 1)) return 'w must be an integer in 1-12';
  if (row.h !== undefined && !(isLayoutInt(row.h, 24) && row.h >= 1)) return 'h must be an integer in 1-24';
  return null;
}

/** The tile as GET serves it: the stored spec plus the draft the builder edits. */
export interface TileView {
  id: string;
  title: string;
  spec: ChartSpec | null;
  draft: ChartDraft | null;
  layout: TileLayout;
  updatedAt: string | null;
}

function tileView(row: AnalyticsTileRow): TileView {
  const tile = rowToTile(row);
  return {
    id: tile.id,
    title: tile.title,
    spec: tile.spec,
    draft: tile.spec ? draftFromSpec(tile.spec) : null,
    layout: tile.layout,
    updatedAt: row.updated_at ?? null,
  };
}

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** What the builder's pickers offer: the caller's exercise categories and "other sport" workout titles. */
async function loadOptions(supabase: Admin, userId: string): Promise<{ categories: string[]; otherWorkoutTitles: string[] }> {
  const [defs, others] = await Promise.all([
    supabase.from('exercise_definitions').select('category').eq('user_id', userId),
    supabase.from('workout_events').select('title').eq('user_id', userId).eq('sport', 'other'),
  ]);
  if (defs.error) throw new Error(`exercise_definitions fetch failed: ${defs.error.message}`);
  if (others.error) throw new Error(`workout_events fetch failed: ${others.error.message}`);
  const distinct = (values: Array<string | null | undefined>) =>
    [...new Set(values.map(v => (v ?? '').trim()).filter(Boolean))].sort();
  return {
    categories: distinct(((defs.data ?? []) as Array<{ category: string | null }>).map(d => d.category)),
    otherWorkoutTitles: distinct(((others.data ?? []) as Array<{ title: string | null }>).map(e => e.title)),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const method = req.method ?? '';
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    res.status(405).send('Method not allowed');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  // Reads share the schedule/query bucket; every write charges `writes`.
  if (!(await enforceRateLimit(supabase, res, userId, method === 'GET' ? 'reads' : 'writes'))) return;

  if (method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('analytics_tiles')
        .select('*')
        .eq('user_id', userId)
        .order('y')
        .order('x');
      if (error) throw new Error(`analytics_tiles fetch failed: ${error.message}`);
      const options = await loadOptions(supabase, userId);
      res.status(200).json({ tiles: ((data ?? []) as AnalyticsTileRow[]).map(tileView), options });
    } catch (err) {
      console.error('[api/analytics-tiles] list failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to load tiles');
    }
    return;
  }

  if (method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.id !== 'string' || !EVENT_ID_PATTERN.test(body.id)) {
      res.status(400).send('Missing or invalid tile id');
      return;
    }
    if ('draft' in body && 'spec' in body) {
      res.status(400).send('Send either spec or draft, not both');
      return;
    }

    let insert: TablesInsert<'analytics_tiles'>;
    let saved: TileView | null = null;
    if ('draft' in body) {
      // The native builder's Save (W9): the draft, validated and converted here.
      const draft = body.draft;
      if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
        res.status(400).send('draft must be an object');
        return;
      }
      const layoutIn = body.layout;
      if (layoutIn !== undefined && (typeof layoutIn !== 'object' || layoutIn === null || Array.isArray(layoutIn))) {
        res.status(400).send('layout must be an object');
        return;
      }
      const badLayout = layoutProblem((layoutIn ?? {}) as Record<string, unknown>);
      if (badLayout) {
        res.status(400).send(badLayout);
        return;
      }
      const layout: TileLayout = { ...DEFAULT_TILE_LAYOUT, ...((layoutIn ?? {}) as Partial<TileLayout>) };

      // The web's own pre-save check, moved server-side so the phone never
      // needs a rule of its own — and so the acceptance "rejected with the
      // server's message" holds for a blank title too.
      const title = (draft as { title?: unknown }).title;
      if (typeof title !== 'string' || !title.trim()) {
        res.status(200).json({ ok: false, problem: 'Give the tile a title' });
        return;
      }
      let built: ReturnType<typeof specFromDraft>;
      try {
        built = specFromDraft(draft as ChartDraft);
      } catch {
        res.status(400).send('draft is not a chart draft');
        return;
      }
      if ('error' in built) {
        res.status(200).json({ ok: false, problem: built.error });
        return;
      }
      const row = tileToRow(body.id, built.spec, layout);
      insert = { ...row, user_id: userId, updated_at: new Date().toISOString() } as TablesInsert<'analytics_tiles'>;
      saved = { id: body.id, title: built.spec.title, spec: built.spec, draft: draftFromSpec(built.spec), layout, updatedAt: insert.updated_at ?? null };
    } else {
      const row = body as Partial<AnalyticsTileRow>;
      const shape = specShapeProblem(row.spec);
      if (shape) {
        res.status(400).send(shape);
        return;
      }
      const upgraded = upgradeSpec(row.spec);
      const deep = upgraded ? deepSpecProblem(upgraded) : 'spec must be a version-1 chart spec';
      if (deep) {
        res.status(400).send(deep);
        return;
      }
      const badLayout = layoutProblem(row);
      if (badLayout) {
        res.status(400).send(badLayout);
        return;
      }

      const { picked, rejected } = pickAllowed(row as Record<string, unknown>, ANALYTICS_TILE_COLUMNS);
      if (rejected.length > 0) {
        console.error('[api/analytics-tiles] upsert rejected unknown fields:', rejected.join(', '));
        res.status(400).send(`Unknown tile fields: ${rejected.join(', ')}`);
        return;
      }
      insert = { ...picked, user_id: userId, updated_at: new Date().toISOString() } as TablesInsert<'analytics_tiles'>;
    }

    // Conflict target is (user_id, id), never a global id: a forged id owned
    // by another user finds no conflict in this user's partition and dies on
    // the PK instead of overwriting the other user's row.
    const { error } = await supabase
      .from('analytics_tiles')
      .upsert(insert, { onConflict: 'user_id,id' });
    if (error) {
      console.error('[api/analytics-tiles] upsert failed:', error.message);
      res.status(500).send('Failed to save tile');
      return;
    }

    res.status(200).json(saved ? { ok: true, id: body.id, tile: saved } : { id: body.id });
    return;
  }

  if (method === 'PATCH') {
    // Layout commit: the debounced write after a drag/resize settles. Every
    // moved tile arrives in one body; each row updates only its position.
    const { layouts } = (req.body ?? {}) as { layouts?: unknown };
    if (!Array.isArray(layouts) || layouts.length < 1 || layouts.length > 100) {
      res.status(400).send('layouts must be an array of 1-100 entries');
      return;
    }
    for (const entry of layouts) {
      const l = (entry ?? {}) as { id?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown };
      if (typeof l.id !== 'string' || !EVENT_ID_PATTERN.test(l.id)) {
        res.status(400).send('Each layout entry needs a valid tile id');
        return;
      }
      if (l.x === undefined || l.y === undefined || l.w === undefined || l.h === undefined) {
        res.status(400).send('Each layout entry needs x, y, w, h');
        return;
      }
      const bad = layoutProblem(l);
      if (bad) {
        res.status(400).send(bad);
        return;
      }
    }

    const stamp = new Date().toISOString();
    for (const entry of layouts as Array<{ id: string; x: number; y: number; w: number; h: number }>) {
      // A tile deleted mid-drag just misses its update — not worth failing
      // the whole commit over.
      const { error } = await supabase
        .from('analytics_tiles')
        .update({ x: entry.x, y: entry.y, w: entry.w, h: entry.h, updated_at: stamp })
        .eq('user_id', userId)
        .eq('id', entry.id);
      if (error) {
        console.error('[api/analytics-tiles] layout update failed:', error.message);
        res.status(500).send('Failed to save layout');
        return;
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  // DELETE
  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (!id) {
    res.status(400).send('Missing id');
    return;
  }

  const { error, count } = await supabase
    .from('analytics_tiles')
    .delete({ count: 'exact' })
    .eq('user_id', userId)
    .eq('id', id);
  if (error) {
    console.error('[api/analytics-tiles] delete failed:', error.message);
    res.status(500).send('Failed to delete tile');
    return;
  }
  if (!count) {
    res.status(404).send('Tile not found');
    return;
  }

  res.status(200).json({ id });
}
