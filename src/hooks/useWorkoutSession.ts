import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExerciseDefinition, WorkoutEvent } from '../types/workout';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../lib/db/types';
import {
  collectUntouchedPlanned,
  makeExtraSet,
  setToRow,
  cardioToRow,
} from '../lib/tracking/plan';
import type { TrackedSectionGroup } from '../lib/tracking/plan';
import { sessionScoreFromRow } from '../lib/tracking/records';
import type { PersonalRecord, SessionScore, WorkoutScoreRecord } from '../lib/tracking/records';
import {
  cancelSession, finishSession, generateCoachSummary, loadSession, saveLogs, swapLoggedExercise,
} from '../lib/tracking/sessionRepo';
import type { RemovedSetKey, SessionInfo } from '../lib/tracking/sessionRepo';
import type { SetField, CardioField } from '../components/tracker/TrackerExercise';
import { registerAgentState } from '../dev/agentBridge';

const AUTOSAVE_DEBOUNCE_MS = 800;

export type CoachStatus = 'loading' | 'ready' | 'unavailable';

export interface SummaryState {
  prs: PersonalRecord[];
  /** The workout-level score this session logged (scored events only). */
  score: SessionScore | null;
  /** Set when that score beat the template's history. */
  scoreRecord: WorkoutScoreRecord | null;
  coachText: string | null;
  coachStatus: CoachStatus;
}

export type FinishOutcome =
  | { status: 'needs-confirm'; count: number }
  /** A scored event needs its score (or an explicit null to skip) first. */
  | { status: 'needs-score' }
  | { status: 'finished' }
  | { status: 'failed' }
  | { status: 'noop' };

/**
 * Owns a workout-tracking session end to end: load/hydrate, in-memory edits
 * with debounced autosave (flushed on tab hide), the elapsed timer, and the
 * finish/cancel/summary lifecycle. The view renders what this returns.
 * `setCompletion` is injected so the hook stays free of ScheduleContext.
 *
 * The model, PR detection and the recap all come from the server (W3):
 * bootstrap hands over the resolved groups, finish hands back the records.
 */
export function useWorkoutSession(
  event: WorkoutEvent | null,
  setCompletion: (id: string, completed: boolean) => void,
) {
  const [groups, setGroups] = useState<TrackedSectionGroup[] | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [isFinishing, setIsFinishing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [summary, setSummary] = useState<SummaryState | null>(null);

  const groupsRef = useRef<TrackedSectionGroup[]>([]);
  const dirtySetsRef = useRef<Set<string>>(new Set());   // `${section}|${exerciseId}|${setNumber}`
  const dirtyCardioRef = useRef<Set<string>>(new Set()); // `${section}|${exerciseId}`
  const removedRef = useRef<RemovedSetKey[]>([]);
  // What the server last reported for this session — bootstrap for a
  // finished session, or the finish response — so reopening the summary
  // costs nothing.
  const recordsRef = useRef<{ prs: PersonalRecord[]; scoreRecord: WorkoutScoreRecord | null }>({ prs: [], scoreRecord: null });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set the moment a cancel is confirmed: blocks the debounced autosave and
  // the visibilitychange flush from re-creating rows after the delete.
  const cancelledRef = useRef(false);

  // Written after commit, not during render (unsafe under StrictMode). The
  // autosave timer and finish/cancel handlers fire well after effects run.
  useEffect(() => {
    if (groups) groupsRef.current = groups;
  }, [groups]);

  // The load effect and flushSave depend on the event only through its id and
  // date: `event` itself gets a fresh object identity on every ScheduleContext
  // refetch/realtime reload, so depending on the object would re-run
  // loadSession on every schedule poll. The primitives are the real reactive
  // inputs; the ref carries the full object for the load effect (same
  // commit-phase pattern as groupsRef above).
  const eventRef = useRef(event);
  useEffect(() => { eventRef.current = event; }, [event]);
  const eventId = event?.id;
  const eventDate = event?.date;

  const isFinished = !!session?.finished_at;

  // ── Load: get-or-create the session, hydrate any previously-saved logs ─────

  useEffect(() => {
    if (!eventId || !eventDate) return;
    const loadEvent = eventRef.current;
    if (!loadEvent) return;
    let cancelled = false;

    loadSession(loadEvent).then(data => {
      if (cancelled) return;
      setSession(data.session);
      recordsRef.current = { prs: data.prs, scoreRecord: data.scoreRecord };
      setGroups(data.groups);
    });

    return () => { cancelled = true; };
  }, [eventId, eventDate]);

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
    if (!eventId || !eventDate || cancelledRef.current) return;

    const setLogs: SetLogRow[] = [];
    for (const key of dirtySetsRef.current) {
      const [section, exerciseId, setNumberStr] = key.split('|');
      const setNumber = Number(setNumberStr);
      for (const group of groupsRef.current) {
        if (group.section !== section) continue;
        const tracked = group.exercises.find(t => t.exercise.id === exerciseId);
        const set = tracked?.sets.find(s => s.setNumber === setNumber);
        if (tracked && set) setLogs.push(setToRow(eventId, eventDate, tracked, set));
      }
    }
    const cardioLogs: CardioLogRow[] = [];
    for (const key of dirtyCardioRef.current) {
      const [section, exerciseId] = key.split('|');
      for (const group of groupsRef.current) {
        if (group.section !== section) continue;
        const tracked = group.exercises.find(t => t.exercise.id === exerciseId);
        if (tracked?.cardio) cardioLogs.push(cardioToRow(eventId, eventDate, tracked));
      }
    }
    const removedSets = removedRef.current;
    if (!setLogs.length && !cardioLogs.length && !removedSets.length) return;

    dirtySetsRef.current = new Set();
    dirtyCardioRef.current = new Set();
    removedRef.current = [];

    await saveLogs(eventId, eventDate, { setLogs, cardioLogs, removedSets }).catch(() => {});
  }, [eventId, eventDate]);

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

  const findTracked = (section: TrackedSection, exerciseId: string) =>
    groupsRef.current.find(g => g.section === section)?.exercises.find(t => t.exercise.id === exerciseId);

  // Focusing a shadow row accepts last session's values as this session's
  // actuals — the tap is what turns a ghost into a log, so it saves like an
  // edit. A whole set is one act: any field commits the row. `values` carries
  // only the fields the row rendered as ghosts, so a shadow dimension the UI
  // never showed can't sneak into the log.
  const onCommitSetShadow = (
    section: TrackedSection,
    exerciseId: string,
    setNumber: number,
    values: Partial<Record<SetField, string>>,
  ) => {
    const set = findTracked(section, exerciseId)?.sets.find(s => s.setNumber === setNumber);
    if (!set?.shadow) return;
    updateExercise(section, exerciseId, t => ({
      ...t,
      sets: t.sets.map(s => (s.setNumber === setNumber ? { ...s, ...values, shadow: null } : s)),
    }));
    dirtySetsRef.current.add(`${section}|${exerciseId}|${setNumber}`);
    scheduleSave();
  };

  // Cardio ghosts commit per field — the metrics are independent.
  const onCommitCardioShadow = (section: TrackedSection, exerciseId: string, field: CardioField) => {
    if (!findTracked(section, exerciseId)?.cardio?.shadow?.[field]) return;
    updateExercise(section, exerciseId, t => ({
      ...t,
      cardio: t.cardio?.shadow
        ? { ...t.cardio, [field]: t.cardio.shadow[field], shadow: { ...t.cardio.shadow, [field]: '' } }
        : t.cardio,
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

  /**
   * Re-point one exercise's logs at a different movement — "I logged ring
   * dips but actually did single-arm DB press". Sets, reps and weights stay
   * put; only what the movement is called changes, and only for this day.
   */
  const onSwapExercise = async (
    section: TrackedSection,
    exerciseId: string,
    def: ExerciseDefinition,
  ): Promise<boolean> => {
    const target = eventRef.current;
    if (!target) return false;

    // Order matters: a pending autosave carries the old name, and would write
    // it straight back over the rows the swap just relabelled.
    await flushSave();

    try {
      await swapLoggedExercise(target.id, target.date, {
        section,
        exerciseId,
        exerciseName: def.canonicalName,
        definitionId: def.id,
      });
    } catch {
      return false;
    }

    // Paint it immediately either way — offline there is nothing to reload,
    // and the renamed model is what subsequent saves serialize. PR detection
    // runs server-side at Finish against the relabelled rows, so nothing
    // else needs refreshing here.
    updateExercise(section, exerciseId, t => {
      const from = t.substitutedFrom ?? t.exercise.name;
      return {
        ...t,
        exercise: { ...t.exercise, name: def.canonicalName, definitionId: def.id },
        // Swapping back to the planned movement is not a substitution.
        substitutedFrom: from === def.canonicalName ? null : from,
      };
    });
    return true;
  };

  // ── Finish / cancel / summary ───────────────────────────────────────────────

  // Stream the coach text into an already-open summary popup. The server
  // rebuilds the recap from the saved rows and persists the result, so
  // reopening the finished session shows the same summary for free.
  const generateSummary = () => {
    if (!event) return;
    generateCoachSummary(event.id, event.date, partial => {
      setSummary(prev => prev && { ...prev, coachText: partial, coachStatus: 'ready' });
    })
      .then(text => {
        setSummary(prev => prev && { ...prev, coachText: text, coachStatus: 'ready' });
        setSession(prev => prev && { ...prev, coach_summary: text });
      })
      .catch(err => {
        console.warn('[apex] Coach summary generation failed:', err);
        setSummary(prev => prev && { ...prev, coachText: null, coachStatus: 'unavailable' });
      });
  };

  /**
   * Finish the session. Without `force`, untouched planned sets make this
   * return needs-confirm (they will be zero-filled) instead of finishing.
   * A scored event (for-time/amrap with a template) then needs its score:
   * undefined returns needs-score, a SessionScore records it, an explicit
   * null skips it (the session finishes unscored and sets no workout PR).
   */
  const requestFinish = async (force: boolean, score?: SessionScore | null): Promise<FinishOutcome> => {
    if (!event || !groups || isFinishing) return { status: 'noop' };

    const autofillRows = collectUntouchedPlanned(event.id, event.date, groups);
    if (!force && autofillRows.length > 0) {
      return { status: 'needs-confirm', count: autofillRows.length };
    }

    const scored = !!event.templateId
      && (event.scoringType === 'for-time' || event.scoringType === 'amrap');
    if (scored && score === undefined) return { status: 'needs-score' };

    setIsFinishing(true);
    try {
      await flushSave();
      const result = await finishSession(
        event.id,
        event.date,
        autofillRows,
        scored && score ? { templateId: event.templateId!, ...score } : undefined,
      );
      const totalSeconds = result?.totalDurationSeconds ?? elapsed;
      setCompletion(event.id, true);
      setSession(prev => prev && {
        ...prev,
        finished_at: new Date().toISOString(),
        total_duration_seconds: totalSeconds,
      });
      setIsFinishing(false);

      // Summary popup before returning to the calendar: the server detected
      // the PRs against full history; the coach text streams in behind.
      const prs = result?.prs ?? [];
      const sessionScore = scored && score ? score : null;
      const scoreRecord = result?.scoreRecord ?? null;
      recordsRef.current = { prs, scoreRecord };
      setSummary({ prs, score: sessionScore, scoreRecord, coachText: null, coachStatus: 'loading' });
      if (result) generateSummary();
      else setSummary(prev => prev && { ...prev, coachStatus: 'unavailable' });
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
  // the records the server reported (bootstrap or finish), and the score
  // straight off the saved session row.
  const openSavedSummary = () => {
    if (!groups) return;
    const { prs, scoreRecord } = recordsRef.current;
    const score = session ? sessionScoreFromRow(session) : null;
    if (session?.coach_summary) {
      setSummary({ prs, score, scoreRecord, coachText: session.coach_summary, coachStatus: 'ready' });
    } else {
      setSummary({ prs, score, scoreRecord, coachText: null, coachStatus: 'loading' });
      generateSummary();
    }
  };

  const dismissSummary = () => setSummary(null);

  return {
    groups,
    session,
    elapsed,
    isFinished,
    isFinishing,
    isCancelling,
    summary,
    onSetChange,
    onCardioChange,
    onCommitSetShadow,
    onCommitCardioShadow,
    onAddSet,
    onRemoveSet,
    onSwapExercise,
    flushSave,
    requestFinish,
    cancelWorkout,
    openSavedSummary,
    dismissSummary,
  };
}
