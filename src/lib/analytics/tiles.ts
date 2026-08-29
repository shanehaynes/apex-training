import type { AnalyticsTileRow } from '../db/types';
import { upgradeSpec, type ChartSpec } from './spec';

// ─── Tile ↔ row mapping ──────────────────────────────────────────────────────
// The persistence shape for analytics_tiles (phase 35). Ids are client-minted
// (the templates.ts precedent); the layout is real columns so a drag commit
// is a plain batched update.

export interface TileLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnalyticsTile {
  id: string;
  /** Null when the stored JSONB fails validation — rendered as an error tile. */
  spec: ChartSpec | null;
  /** The stored title even when the spec is invalid, so error tiles stay nameable. */
  title: string;
  layout: TileLayout;
}

export const DEFAULT_TILE_LAYOUT: TileLayout = { x: 0, y: 0, w: 6, h: 4 };

export function mintTileId(): string {
  return `tile-${crypto.randomUUID()}`;
}

type TileRowInsert = Omit<AnalyticsTileRow, 'created_at' | 'updated_at'>;

export function rowToTile(row: AnalyticsTileRow): AnalyticsTile {
  const spec = upgradeSpec(row.spec);
  const rawTitle = (row.spec as { title?: unknown } | null)?.title;
  return {
    id: row.id,
    spec,
    title: spec?.title ?? (typeof rawTitle === 'string' ? rawTitle : 'Invalid tile'),
    layout: { x: row.x, y: row.y, w: row.w, h: row.h },
  };
}

export function tileToRow(id: string, spec: ChartSpec, layout: TileLayout): TileRowInsert {
  return {
    id,
    spec: spec as unknown as Record<string, unknown>,
    x: layout.x,
    y: layout.y,
    w: layout.w,
    h: layout.h,
  };
}
