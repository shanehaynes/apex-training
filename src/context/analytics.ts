import { createContext, useContext } from 'react';
import type { ChartDraft } from '../lib/analytics/draft';
import type { ChartSpec } from '../lib/analytics/spec';
import type { TileLayout } from '../lib/analytics/tiles';

// Context object + hook live apart from the provider so AnalyticsContext.tsx
// exports only a component and stays eligible for React Fast Refresh.
//
// The wire types below are DECLARED here, not imported from
// api/_lib/handlers/analyticsTiles.ts: nothing under src/ imports from api/
// (that module reaches the service-role client). They are the /api/analytics-
// tiles contract, pinned on the server side by api/__tests__/analytics-
// tiles.test.ts and in the browser by e2e/lib/mock/analytics.mjs.

/** One tile as GET /api/analytics-tiles serves it. */
export interface TileView {
  id: string;
  /** The stored title even when the spec no longer validates, so error tiles stay nameable. */
  title: string;
  /** Null when the stored spec fails the server's validation — rendered as an error tile. */
  spec: ChartSpec | null;
  /** `draftFromSpec(spec)`, run server-side: what the builder edits. Null alongside a null spec. */
  draft: ChartDraft | null;
  layout: TileLayout;
  updatedAt: string | null;
}

/** What the builder's pickers offer beyond the static catalog (GET serves it). */
export interface TileOptions {
  categories: string[];
  otherWorkoutTitles: string[];
}

export const EMPTY_TILE_OPTIONS: TileOptions = { categories: [], otherWorkoutTitles: [] };

/**
 * What a save answered. `ok:false` carries the server's person-phrased problem
 * (a blank title, or `chartDraftProblem`'s text) and is passed to the builder
 * untouched; `null` means the request itself failed, already toasted by
 * lib/api.ts.
 */
export type SaveTileResult = { ok: true; tile: TileView } | { ok: false; problem: string };

export interface AnalyticsContextValue {
  tiles: TileView[];
  options: TileOptions;
  isLoading: boolean;
  /**
   * Upsert one tile (create or edit). The SERVER builds the spec from the
   * draft (`specFromDraft`) and owns the refusals, so both clients validate
   * in exactly one place (W9, docs/ios/decisions.md D-029).
   */
  saveTile: (id: string, draft: ChartDraft, layout: TileLayout) => Promise<SaveTileResult | null>;
  /** Commit moved tiles after a drag/resize settles. Optimistic. */
  saveLayouts: (layouts: Array<{ id: string } & TileLayout>) => Promise<void>;
  removeTile: (id: string) => Promise<boolean>;
}

export const AnalyticsContext = createContext<AnalyticsContextValue | null>(null);

export function useAnalytics(): AnalyticsContextValue {
  const ctx = useContext(AnalyticsContext);
  if (!ctx) throw new Error('useAnalytics must be used within an AnalyticsProvider');
  return ctx;
}
