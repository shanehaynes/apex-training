import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteJson, patchJson, postJson } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import { useDebouncedReload } from '../hooks/useDebouncedReload';
import type { AnalyticsTileRow } from '../lib/db/types';
import { rowToTile, tileToRow, type AnalyticsTile, type TileLayout } from '../lib/analytics/tiles';
import type { ChartSpec } from '../lib/analytics/spec';
import { registerAgentState } from '../dev/agentBridge';
import { AnalyticsContext, type AnalyticsContextValue } from './analytics';

// Saved dashboard tiles (phase 35). The BlocksContext posture: anon-client
// reads under RLS, writes through /api/analytics-tiles, realtime re-fetch,
// graceful empty state offline. Writes apply optimistically — the dashboard
// is the only writer of its own tiles, so a drag commit or save must not
// wait a network round-trip to render.
//
// Chart DATA (the log rows tiles aggregate) deliberately does NOT live here:
// useAnalyticsData owns that per-view, window-bounded, so an open dashboard
// never keeps a year of set logs in app-wide state.

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const [tiles, setTiles] = useState<AnalyticsTile[]>([]);
  const [isLoading, setIsLoading] = useState(!!supabase);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setTiles([]);
      setIsLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('analytics_tiles')
      .select('*')
      .order('y')
      .order('x');
    if (error) console.warn('[apex] Failed to load analytics_tiles:', error.message);
    else setTiles((data as AnalyticsTileRow[]).map(rowToTile));
    setIsLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const scheduleRefresh = useDebouncedReload(refresh);

  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const channel = sb
      .channel('analytics-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analytics_tiles' }, scheduleRefresh)
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [scheduleRefresh]);

  const saveTile = useCallback(async (id: string, spec: ChartSpec, layout: TileLayout) => {
    setTiles(prev => {
      const next: AnalyticsTile = { id, spec, title: spec.title, layout };
      const i = prev.findIndex(t => t.id === id);
      if (i === -1) return [...prev, next];
      const copy = [...prev];
      copy[i] = next;
      return copy;
    });
    try {
      await postJson<{ id: string }>('/api/analytics-tiles', tileToRow(id, spec, layout), 'Save tile');
      return true;
    } catch {
      await refresh(); // roll the optimistic write back to the truth
      return false;
    }
  }, [refresh]);

  const saveLayouts = useCallback(async (layouts: Array<{ id: string } & TileLayout>) => {
    const byId = new Map(layouts.map(l => [l.id, l]));
    setTiles(prev => prev.map(t => {
      const l = byId.get(t.id);
      return l ? { ...t, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : t;
    }));
    try {
      await patchJson('/api/analytics-tiles', { layouts }, 'Save layout');
    } catch {
      await refresh();
    }
  }, [refresh]);

  const removeTile = useCallback(async (id: string) => {
    setTiles(prev => prev.filter(t => t.id !== id));
    try {
      await deleteJson<{ id: string }>(`/api/analytics-tiles?id=${encodeURIComponent(id)}`, 'Delete tile');
      return true;
    } catch {
      await refresh();
      return false;
    }
  }, [refresh]);

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('analytics', () => ({
      tiles: tiles.map(t => ({
        id: t.id,
        title: t.title,
        valid: t.spec !== null,
        layout: t.layout,
        measures: t.spec?.series.map(s => s.measure) ?? [],
      })),
      isLoading,
    }));
  }, [tiles, isLoading]);

  const value = useMemo<AnalyticsContextValue>(
    () => ({ tiles, isLoading, saveTile, saveLayouts, removeTile }),
    [tiles, isLoading, saveTile, saveLayouts, removeTile],
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}
