import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, postJson } from '../lib/api';
import { notify } from '../lib/notify';
import { useAuth } from '../context/AuthContext';
import { useSchedule } from '../context/ScheduleContext';

// The COROS sync flow (useTemplateCopy shape, plus a confirmation queue).
// runSync previews, queues every proposed FILL for a per-item yes/no —
// unmatched activities import without asking — then sends ONE apply with
// every decision: fill on yes, standalone create on no. Nothing is written
// until that apply, so closing the tab mid-queue changes nothing.

export type ProviderStatus = 'unknown' | 'disconnected' | 'pending' | 'connected' | 'expired';

export interface SyncProposal {
  activity: {
    activityId: string;
    sportLabel: string;
    apexType: string;
    localDate: string;
    displayTime: string;
    durationMin: number;
    distance: string | null;
    avgHr: number | null;
  };
  match: { eventId: string; eventDate: string; title: string; startTime: string | null; type: string } | null;
}

interface Decision {
  activityId: string;
  action: 'fill' | 'create';
  targetEventId?: string;
  eventDate?: string;
}

interface StatusResponse {
  coros: {
    status: Exclude<ProviderStatus, 'unknown'>;
    lastSyncedAt: string | null;
    connectedAt: string | null;
    configured: boolean;
    autoSync: boolean;
    pendingFillCount: number;
  };
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function useProviderSync() {
  const { status: authStatus } = useAuth();
  const { refreshEvents, refreshCompletions } = useSchedule();

  const [status, setStatus] = useState<ProviderStatus>('unknown');
  const [configured, setConfigured] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [autoSync, setAutoSyncState] = useState(true);
  const [pendingFillCount, setPendingFillCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  /** FILL proposals awaiting the user, head = the one on screen. The ref is
   *  the source of truth; state mirrors it for render. Settling mutates the
   *  ref outside any state updater so StrictMode's double-invoked updaters
   *  can't duplicate a decision. */
  const [pendingFills, setPendingFills] = useState<SyncProposal[]>([]);
  const queueRef = useRef<SyncProposal[]>([]);
  const decisionsRef = useRef<Decision[]>([]);
  // Synchronous double-click latch (ChatSidebar precedent): state re-renders
  // too late to stop a second click from double-settling the queue head.
  const settleLatchRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await postJson<Partial<StatusResponse>>('/api/provider-sync', { action: 'status' }, 'Sync status');
      // Defensive: a stubbed or older server may answer without the
      // projection; treat that as unknown rather than crashing the nav.
      setStatus(data.coros?.status ?? 'unknown');
      setConfigured(data.coros?.configured ?? false);
      setLastSyncedAt(data.coros?.lastSyncedAt ?? null);
      setAutoSyncState(data.coros?.autoSync ?? true);
      setPendingFillCount(data.coros?.pendingFillCount ?? 0);
    } catch {
      /* postJson already toasted; leave status unknown */
    }
  }, []);

  useEffect(() => {
    if (authStatus === 'signedIn') refreshStatus();
  }, [authStatus, refreshStatus]);

  const startConnect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const { authorizeUrl } = await postJson<{ authorizeUrl: string }>(
        '/api/provider-sync', { action: 'connect-start', provider: 'coros' }, 'COROS connect',
      );
      window.location.assign(authorizeUrl);
      // No setIsConnecting(false) on success — the page is navigating away.
    } catch {
      setIsConnecting(false);
    }
  }, []);

  const setAutoSync = useCallback(async (enabled: boolean) => {
    // Optimistic — the checkbox answers immediately; a failure reverts.
    setAutoSyncState(enabled);
    try {
      await postJson('/api/provider-sync', { action: 'set-auto-sync', provider: 'coros', enabled }, 'Auto-sync setting');
    } catch {
      setAutoSyncState(!enabled);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await postJson('/api/provider-sync', { action: 'disconnect', provider: 'coros' }, 'COROS disconnect');
      setStatus('disconnected');
      setLastSyncedAt(null);
      notify('COROS disconnected');
    } catch {
      /* toasted */
    }
  }, []);

  const submitApply = useCallback(async (decisions: Decision[]) => {
    if (decisions.length === 0) {
      notify('Everything up to date');
      setIsSyncing(false);
      return;
    }
    try {
      const result = await postJson<{ created: number; filled: number; errors: unknown[] }>(
        '/api/provider-sync',
        { action: 'apply', provider: 'coros', timezone: browserTimezone(), decisions },
        'COROS import',
      );
      // Catch-up loads run behind the toast — the user gets the outcome
      // immediately, and realtime already covers workout_events anyway.
      void Promise.all([refreshEvents(), refreshCompletions()]).catch(() => {});
      const parts = [
        result.created > 0 ? `imported ${result.created} ${result.created === 1 ? 'activity' : 'activities'}` : null,
        result.filled > 0 ? `filled ${result.filled} planned ${result.filled === 1 ? 'workout' : 'workouts'}` : null,
        result.errors.length > 0 ? `${result.errors.length} failed` : null,
      ].filter(Boolean);
      const summary = parts.length ? parts.join(' · ') : 'nothing new';
      notify(`COROS: ${summary.charAt(0).toUpperCase()}${summary.slice(1)}`);
      setLastSyncedAt(new Date().toISOString());
      setPendingFillCount(0);
    } catch {
      /* toasted */
    } finally {
      setIsSyncing(false);
    }
  }, [refreshEvents, refreshCompletions]);

  const runSync = useCallback(async () => {
    setIsSyncing(true);
    decisionsRef.current = [];
    try {
      const { proposals } = await postJson<{ proposals: SyncProposal[] }>(
        '/api/provider-sync',
        { action: 'preview', provider: 'coros', timezone: browserTimezone() },
        'COROS sync',
      );
      const fills = proposals.filter(p => p.match !== null);
      // Unmatched activities import without confirmation (decided product
      // behavior) — they go straight into the decision list.
      decisionsRef.current = proposals
        .filter(p => p.match === null)
        .map(p => ({ activityId: p.activity.activityId, action: 'create' as const }));

      if (fills.length > 0) {
        settleLatchRef.current = false;
        queueRef.current = fills;
        setPendingFills(fills);
        // isSyncing stays true; submitApply runs when the queue settles.
      } else {
        await submitApply(decisionsRef.current);
      }
    } catch (err) {
      setIsSyncing(false);
      if (err instanceof ApiError && err.status === 409) {
        setStatus('expired');
        notify('COROS connection expired — reconnect in Profile');
      }
    }
  }, [submitApply]);

  /** Settle the queue head: fill on yes, standalone create on no. */
  const confirmFill = useCallback((accept: boolean) => {
    if (settleLatchRef.current) return;
    settleLatchRef.current = true;
    const [head, ...rest] = queueRef.current;
    if (!head) {
      settleLatchRef.current = false;
      return;
    }
    decisionsRef.current.push(
      accept && head.match
        ? { activityId: head.activity.activityId, action: 'fill', targetEventId: head.match.eventId, eventDate: head.match.eventDate }
        : { activityId: head.activity.activityId, action: 'create' },
    );
    queueRef.current = rest;
    setPendingFills(rest);
    if (rest.length === 0) {
      // Last one — hand the full decision set to apply.
      void submitApply([...decisionsRef.current]);
    } else {
      settleLatchRef.current = false;
    }
  }, [submitApply]);

  return {
    status,
    configured,
    lastSyncedAt,
    autoSync,
    setAutoSync,
    pendingFillCount,
    isSyncing,
    isConnecting,
    pendingFills,
    refreshStatus,
    startConnect,
    disconnect,
    runSync,
    confirmFill,
  };
}
