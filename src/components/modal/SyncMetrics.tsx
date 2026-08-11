import { useEffect, useState, type ReactElement } from 'react';
import { HeartPulse, Flame, TrendingUp, Route, Watch } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import StreamCharts, { type Streams } from './StreamCharts';

// Measured provider metrics for an event, read lazily from activity_streams
// (per-user anon SELECT policy) — the calendar payload never carries them.
// Provenance quirk: a provider-CREATED event has event.source set, but a
// FILLED planned occurrence doesn't (its base row is untouched), so
// presence of the streams row — keyed by occurrence id + date — is the
// authoritative signal for both.

interface StreamSummary {
  sportLabel?: string;
  avgHr?: number | null;
  maxHr?: number | null;
  calories?: number | null;
  distanceMeters?: number | null;
  elevationGainMeters?: number | null;
  trainingLoad?: number | null;
}

const PROVIDER_LABELS: Record<string, string> = { coros: 'COROS' };

export default function SyncMetrics({ eventId, eventDate }: { eventId: string; eventDate: string }) {
  const [row, setRow] = useState<{ provider: string; summary: StreamSummary; streams: Streams | null } | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase
      .from('activity_streams')
      .select('provider, summary, streams')
      .eq('event_id', eventId)
      .eq('event_date', eventDate)
      .maybeSingle()
      .then(({ data, error }) => {
        // Silent on absence or error — this strip is enrichment, and most
        // events legitimately have no streams row.
        if (!cancelled && !error && data) setRow(data as { provider: string; summary: StreamSummary; streams: Streams | null });
      });
    return () => { cancelled = true; };
  }, [eventId, eventDate]);

  if (!row) return null;
  const s = row.summary ?? {};
  const providerLabel = PROVIDER_LABELS[row.provider] ?? row.provider;

  const items: Array<{ icon: ReactElement; label: string }> = [];
  if (s.avgHr) items.push({ icon: <HeartPulse size={13} strokeWidth={1.5} />, label: `${s.avgHr}${s.maxHr ? `/${s.maxHr}` : ''} bpm` });
  if (s.distanceMeters) items.push({ icon: <Route size={13} strokeWidth={1.5} />, label: `${(s.distanceMeters / 1609.344).toFixed(2)} mi` });
  if (s.elevationGainMeters) items.push({ icon: <TrendingUp size={13} strokeWidth={1.5} />, label: `${Math.round(s.elevationGainMeters * 3.28084)} ft` });
  if (s.calories) items.push({ icon: <Flame size={13} strokeWidth={1.5} />, label: `${s.calories} cal` });
  if (s.trainingLoad) items.push({ icon: <Watch size={13} strokeWidth={1.5} />, label: `Load ${s.trainingLoad}` });

  return (
    <>
      <div className="sync-metrics" data-testid="sync-metrics">
        <span className="sync-badge">
          <Watch size={12} strokeWidth={1.5} /> Synced from {providerLabel}
        </span>
        {items.map((item, i) => (
          <span className="sync-metrics__item" key={i}>
            {item.icon} <strong>{item.label}</strong>
          </span>
        ))}
      </div>
      {row.streams && <StreamCharts streams={row.streams} />}
    </>
  );
}
