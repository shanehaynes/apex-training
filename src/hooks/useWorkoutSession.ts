import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkoutEvent } from '../types/workout';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../lib/db/types';
import {
  buildTrackerModel,
  buildLastPerformance,
  collectUntouchedPlanned,
  makeExtraSet,
  setToRow,
  cardioToRow,
} from '../lib/tracking/plan';
import type { LastPerformance, TrackedSectionGroup } from '../lib/tracking/plan';
import { computeSessionPRs } from '../lib/tracking/records';
import type { PersonalRecord } from '../lib/tracking/records';
import { buildSessionRecap, generateCoachSummary } from '../lib/coach/summary';
import { cancelSession, finishSession, loadSession, saveLogs, saveSummary } from '../lib/tracking/sessionRepo';
import type { RemovedSetKey, SessionInfo } from '../lib/tracking/sessionRepo';
import type { SetField, CardioField } from '../components/tracker/TrackerExercise';
import { registerAgentState } from '../dev/agentBridge';

const AUTOSAVE_DEBOUNCE_MS = 800;

export type CoachStatus = 'loading' | 'ready' | 'unavailable';

export interface SummaryState {
  prs: PersonalRecord[];
  coachText: string | null;
  coachStatus: CoachStatus;
}

export type FinishOutcome =
  | { status: 'needs-confirm'; count: number }
  | { status: 'finished' }
  | { status: 'failed' }
  | { status: 'noop' };

/**
 * Owns a workout-tracking session end to end: load/hydrate, in-memory edits
 * with debounced autosave (flushed on tab hide), the elapsed timer, and the
 * finish/cancel/summary lifecycle. The view renders what this returns.
 * `setCompletion` is injected so the hook stays free of ScheduleContext.
 */
export function useWorkoutSession(
  event: WorkoutEvent | null,
  setCompletion: (id: string, completed: boolean) => void,
) {
  const [groups, setGroups] = useState<TrackedSectionGroup[] | null>(null);
  const [lastByName, setLastByName] = useState<Map<string, LastPerformance>>(() => new Map());
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [summary, setSummary] = useState<SummaryState | null>(null);

  const groupsRef = useRef<TrackedSectionGroup[]>([]);
  const dirtySetsRef = useRef<Set<string>>(new Set());   // `${section}|${exerciseId}|${setNumber}`
  const dirtyCardioRef = useRef<Set<string>>(new Set()); // `${section}|${exerciseId}`
  const removedRef = useRef<RemovedSetKey[]>([]);
  const historyRef = useRef<SetLogRow[]>([]);
  const cardioHistoryRef = useRef<CardioLogRow[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set the moment a cancel is confirmed: blocks the debounced autosave and
  // the visibilitychange flush from re-creating rows after the delete.
  const cancelledRef = useRef(false);

  if (groups) groupsRef.current = groups;

  const isFinished = !!session?.finished_at;

  // ── Load: get-or-create the session, hydrate any previously-saved logs ─────

  useEffect(() => {
    if (!event) return;
    let cancelled = false;

    loadSession(event).then(data => {
      if (cancelled) return;
      setSession(data.session);
      historyRef.current = data.history;
      cardioHistoryRef.current = data.cardioHistory;
      setLastByName(buildLastPerformance(data.history));
      setGroups(buildTrackerModel(event, data.savedSets, data.savedCardio));
    });

    return () => { cancelled = true; };
  }, [event?.id, event?.date]);

  // ── Elapsed timer — derived from server started_at, immune to tab sleep ────

  useEffect(() => {
    if (!session) return;
    if (session.finished_at) {
      setElapsed(session.total_duration_seconds ?? 0);
      return;
    }
    const startMs = new Date(session.started_at).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [session]);

  // Dev-only agent bridge: compiled out of production builds. Elapsed is
  // derived from started_at at read time so the snapshot never goes stale.
  useEffect(() => {
    if (!import.meta.env.DEV || !event) return;
    return registerAgentState('workoutSession', () => ({
      eventId: event.id,
      eventDate: event.date,
      eventTitle: event.title,
      session,
      isFinished: !!session?.finished_at,
      elapsedSeconds: !session
        ? null
        : session.finished_at
        ? session.total_duration_seconds ?? 0
        : Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000)),
      groups,
      summary: summary && {
        prs: summary.prs,
        coachStatus: summary.coachStatus,
        coachText: summary.coachText,
      },
    }));
  }, [event, session, groups, summary]);

  // ── Autosave ────────────────────────────────────────────────────────────────

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (!event || cancelledRef.current) return;

    const setLogs: SetLogRow[] = [];
    for (const key of dirtySetsRef.current) {
      const [section, exerciseId, setNumberStr] = key.split('|');
      const setNumber = Number(setNumberStr);
      for (const group of groupsRef.current) {
        if (group.section !== section) continue;
        const tracked = group.exercises.find(t => t.exercise.id === exerciseId);
        const set = tracked?.sets.find(s => s.setNumber === setNumber);
        if (tracked && set) setLogs.push(setToRow(event.id, event.date, tracked, set));
      }
    }
    const cardioLogs: CardioLogRow[] = [];
    for (const key of dirtyCardioRef.current) {
      const [section, exerciseId] = key.split('|');
      for (const group of groupsRef.current) {
        if (group.section !== section) continue;
        const tracked = group.exercises.find(t => t.exercise.id === exerciseId);
        if (tracked?.cardio) cardioLogs.push(cardioToRow(event.id, event.date, tracked));
      }
    }
    const removedSets = removedRef.current;
    if (!setLogs.length && !cardioLogs.length && !removedSets.length) return;

    dirtySetsRef.current = new Set();
    dirtyCardioRef.current = new Set();
    removedRef.current = [];

    await saveLogs(event.id, event.date, { setLogs, cardioLogs, removedSets }).catch(() => {});
  }, [event?.id, event?.date]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush pending edits when the tab is backgrounded or closed mid-workout.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushSave(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flushSave]);

  // ── Mutations ───────────────────────────────────────────────────────────────

  const updateExercise = (
    section: TrackedSection,
    exerciseId: string,
    update: (t: TrackedSectionGroup['exercises'][number]) => TrackedSectionGroup['exercises'][number],
  ) => {
    setGroups(prev => prev && prev.map(g =>
      g.section !== section
        ? g
        : { ...g, exercises: g.exercises.map(t => (t.exercise.id === exerciseId ? update(t) : t)) },
    ));
  };

  const onSetChange = (section: TrackedSection, exerciseId: string, setNumber: number, field: SetField, value: string) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      sets: t.sets.map(s => (s.setNumber === setNumber ? { ...s, [field]: value } : s)),
    }));
    dirtySetsRef.current.add(`${section}|${exerciseId}|${setNumber}`);
    scheduleSave();
  };

  const onCardioChange = (section: TrackedSection, exerciseId: string, field: CardioField, value: string) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      cardio: t.cardio && { ...t.cardio, [field]: value },
    }));
    dirtyCardioRef.current.add(`${section}|${exerciseId}`);
    scheduleSave();
  };

  const onAddSet = (section: TrackedSection, exerciseId: string) => {
    updateExercise(section, exerciseId, t => {
      const next = t.sets.length ? Math.max(...t.sets.map(s => s.setNumber)) + 1 : 1;
      return { ...t, sets: [...t.sets, makeExtraSet(next)] };
    });
  };

  const onRemoveSet = (section: TrackedSection, exerciseId: string, setNumber: number) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      sets: t.sets.filter(s => !(s.isExtra && s.setNumber === setNumber)),
    }));
    dirtySetsRef.current.delete(`${section}|${exerciseId}|${setNumber}`);
    removedRef.current.push({ section, exerciseId, setNumber });
    scheduleSave();
  };

  // ── Finish / cancel / summary ───────────────────────────────────────────────

  // Generate the coach text for an already-open summary popup, then persist
  // it so reopening the finished session shows the same summary for free.
  const generateAndSaveSummary = (
    groupsSnapshot: TrackedSectionGroup[],
    prs: PersonalRecord[],
    durationSeconds: number | null,
  ) => {
    if (!event) return;
    const recap = buildSessionRecap(event, groupsSnapshot, durationSeconds, prs);
    generateCoachSummary(recap)
      .then(text => {
        setSummary(prev => prev && { ...prev, coachText: text, coachStatus: 'ready' });
        setSession(prev => prev && { ...prev, coach_summary: text });
        saveSummary(event.id, event.date, text);
      })
      .catch(err => {
        console.warn('[apex] Coach summary generation failed:', err);
        setSummary(prev => prev && { ...prev, coachStatus: 'unavailable' });
      });
  };

  /**
   * Finish the session. Without `force`, untouched planned sets make this
   * return needs-confirm (they will be zero-filled) instead of finishing.
   */
  const requestFinish = async (force: boolean): Promise<FinishOutcome> => {
    if (!event || !groups || isFinishing) return { status: 'noop' };

    const autofillRows = collectUntouchedPlanned(event.id, event.date, groups);
    if (!force && autofillRows.length > 0) {
      return { status: 'needs-confirm', count: autofillRows.length };
    }

    setIsFinishing(true);
    try {
      await flushSave();
      const serverSeconds = await finishSession(event.id, event.date, autofillRows);
      const totalSeconds = serverSeconds ?? elapsed;
      setCompletion(event.id, true);
      setSession(prev => prev && {
        ...prev,
        finished_at: new Date().toISOString(),
        total_duration_seconds: totalSeconds,
      });
      setIsFinishing(false);

      // Summary popup before returning to the calendar: PRs are computed
      // here, client-side; the coach text streams in behind the popup.
      const prs = computeSessionPRs(groupsRef.current, historyRef.current, cardioHistoryRef.current);
      setSummary({ prs, coachText: null, coachStatus: 'loading' });
      generateAndSaveSummary(groupsRef.current, prs, totalSeconds);
      return { status: 'finished' };
    } catch {
      setIsFinishing(false);
      return { status: 'failed' };
    }
  };

  /** Discard the session entirely. Resolves false when the delete failed. */
  const cancelWorkout = async (): Promise<boolean> => {
    if (!event || isCancelling) return false;

    cancelledRef.current = true;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    dirtySetsRef.current = new Set();
    dirtyCardioRef.current = new Set();
    removedRef.current = [];

    setIsCancelling(true);
    try {
      await cancelSession(event.id, event.date);
      // A finished session set the completion flag — forgetting the workout
      // forgets that too. A never-finished session never completed anything.
      if (isFinished) setCompletion(event.id, false);
      return true;
    } catch {
      cancelledRef.current = false;
      setIsCancelling(false);
      return false;
    }
  };

  // Reopen the summary on an already-finished session — saved coach text,
  // freshly recomputed PRs (history still predates this event's date).
  const openSavedSummary = () => {
    if (!groups) return;
    const prs = computeSessionPRs(groupsRef.current, historyRef.current, cardioHistoryRef.current);
    if (session?.coach_summary) {
      setSummary({ prs, coachText: session.coach_summary, coachStatus: 'ready' });
    } else {
      setSummary({ prs, coachText: null, coachStatus: 'loading' });
      generateAndSaveSummary(groupsRef.current, prs, session?.total_duration_seconds ?? null);
    }
  };

  const dismissSummary = () => setSummary(null);

  return {
    groups,
    lastByName,
    session,
    elapsed,
    isFinished,
    isFinishing,
    isCancelling,
    summary,
    onSetChange,
    onCardioChange,
    onAddSet,
    onRemoveSet,
    flushSave,
    requestFinish,
    cancelWorkout,
    openSavedSummary,
    dismissSummary,
  };
}
