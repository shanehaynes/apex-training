import { createContext, useContext } from 'react';
import type { AnalyticsTile, TileLayout } from '../lib/analytics/tiles';
import type { ChartSpec } from '../lib/analytics/spec';

// Context object + hook live apart from the provider so AnalyticsContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

export interface AnalyticsContextValue {
  tiles: AnalyticsTile[];
  isLoading: boolean;
  /** Upsert one tile (create or edit). Optimistic; realtime reconciles. */
  saveTile: (id: string, spec: ChartSpec, layout: TileLayout) => Promise<boolean>;
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
