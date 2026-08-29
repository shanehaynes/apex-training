import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { pickAllowed, ANALYTICS_TILE_COLUMNS, EVENT_ID_PATTERN } from '../allowlist.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { AnalyticsTileRow, TablesInsert } from '../../../src/lib/db/types.js';

// Analytics dashboard tiles (phase 35), served as /api/analytics-tiles by
// the consolidated router (_lib/app.ts). POST upserts one tile scoped to
// (user_id, id); PATCH commits grid layouts in batch (the debounced
// drag/resize write); DELETE removes a tile outright — nothing keys history
// on a tile id, so there is no archive state (unlike templates). No AI cap
// or mutation log: the coach has no tile tools in chat mode — the analytics
// coach edits an unsaved draft, and only the user's Save writes here.
//
// The spec column is validated loosely here (shape, version, series count)
// and strictly client-side by specProblem (src/lib/analytics/spec.ts) — the
// blocks weekly_targets precedent: the allowlist guards column names, the
// domain module guards contents, and the renderer shows an error tile for
// anything invalid rather than trusting the row.

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  if (req.method === 'POST') {
    const row = (req.body ?? {}) as Partial<AnalyticsTileRow>;
    if (typeof row.id !== 'string' || !EVENT_ID_PATTERN.test(row.id)) {
      res.status(400).send('Missing or invalid tile id');
      return;
    }
    const specProblem = specShapeProblem(row.spec);
    if (specProblem) {
      res.status(400).send(specProblem);
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

    // Conflict target is (user_id, id), never a global id: a forged id owned
    // by another user finds no conflict in this user's partition and dies on
    // the PK instead of overwriting the other user's row.
    const { error } = await supabase
      .from('analytics_tiles')
      .upsert(
        { ...picked, user_id: userId, updated_at: new Date().toISOString() } as TablesInsert<'analytics_tiles'>,
        { onConflict: 'user_id,id' },
      );
    if (error) {
      console.error('[api/analytics-tiles] upsert failed:', error.message);
      res.status(500).send('Failed to save tile');
      return;
    }

    res.status(200).json({ id: row.id });
    return;
  }

  if (req.method === 'PATCH') {
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

  if (req.method === 'DELETE') {
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
    return;
  }

  res.status(405).send('Method not allowed');
}
