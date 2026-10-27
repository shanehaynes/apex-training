import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExerciseDefinition, WorkoutEvent } from '../types/workout';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../lib/db/types';
import {
  collectUntouchedPlanned,
  makeAddedExercise,
  makeExtraSet,
  setToRow,
  cardioToRow,
} from '../lib/tracking/plan';
import { sectionLabels } from '../lib/climbing';
import type { TrackedSectionGroup, TrackedSet } from '../lib/tracking/plan';
import { sessionScoreFromRow } from '../lib/tracking/records';
import { clearResolvedLoads } from '../lib/tracking/percent';
import { exerciseOrderOf, moveTrackedExercise, type ExerciseOrder } from '../lib/tracking/order';
import type { PersonalRecord, SessionScore, WorkoutScoreRecord } from '../lib/tracking/records';
import {
  cancelSession, editSessionTimes, finishSession, generateCoachSummary, loadSession, saveLogs, swapLoggedExercise,
} from '../lib/tracking/sessionRepo';
import type { ExerciseNoteEdit, RemovedSetKey, SessionInfo } from '../lib/tracking/sessionRepo';
import { notify } from '../lib/notify';
import { createSaveQueue, isAuthFailure, isNonRetryable } from '../lib/tracking/saveQueue';
import type { PausedStatus, SaveQueue, SaveQueueState } from '../lib/tracking/saveQueue';
import type { SetField, CardioField } from '../components/tracker/TrackerExercise';
import { registerAgentState } from '../dev/agentBridge';
import { useAuth } from '../context/auth';
import { knownUnitContext, rowWithExplicitUnit, type WeightContext } from '../lib/tracking/weight';

const AUTOSAVE_DEBOUNCE_MS = 800;

/** The queue's state as the tracker paints it: the queue's own plus what paused it. */
export interface TrackerSaveState extends SaveQueueState {
  pausedStatus: PausedStatus | null;
}

const IDLE_SAVE_STATE: TrackerSaveState = {
  pending: 0, inFlight: false, consecutiveFailures: 0, showBar: false, nextRetryAt: null,
  rejected: 0, rejectedKeys: [], paused: false, pausedStatus: null,
};

const refusedMessage = (n: number) => `${n} ${n === 1 ? 'edit was' : 'edits were'} refused — edit again to resend`;

/**
 * What the user has to do before a paused queue can send again, as a clause
 * for a toast: a 401 is a lost session, a 403 is the terms changing under a
 * signed-in user (api/_lib/auth.ts), which only accepting them clears.
 */
export const pauseCause = (status: PausedStatus | null) =>
  status === 403 ? 'the terms changed; accept them from Profile' : 'sign in again';

/**
 * The toast for one failed autosave send, or null for none. The save queue
 * owns this, not the transport (saveLogs only throws):
 * - auth (401/403) pauses the queue and says what clears it;
 * - a refusal (other 4xx) is not retried, so it shows the server's own
 *   message once — but only for a single key, the row the user can act on
 *   (a batch is isolated into singles by the queue), and never for a
 *   `removed|` key, which the queue drops: nothing to edit;
 * - anything else (5xx, 408, 429, a dead socket) is retried; only the first
 *   failure of a streak toasts (`firstOfStreak`), the Unsaved bar after that.
 */
export function autosaveFailureToast(err: unknown, keys: readonly string[], firstOfStreak: boolean): string | null {
  if (isAuthFailure(err)) {
    return `Autosave paused — ${pauseCause((err as { status?: number }).status === 403 ? 403 : 401)}, then Retry`;
  }
  if (isNonRetryable(err)) {
    return keys.length === 1 && !keys[0].startsWith('removed|')
      ? `Autosave refused: ${(err as Error).message.slice(0, 140)}`
      : null;
  }
  return firstOfStreak ? 'Autosave failed' : null;
}

// Dirty keys, as the save queue tracks them. One key per row the server
// upserts or deletes, so a key stays dirty until the send that carried its
// latest value resolves.
const setKey = (section: TrackedSection, exerciseId: string, setNumber: number) => `set|${section}|${exerciseId}|${setNumber}`;
const cardioKey = (section: TrackedSection, exerciseId: string) => `cardio|${section}|${exerciseId}`;
const noteKey = (section: TrackedSection, exerciseId: string) => `note|${section}|${exerciseId}`;
const removedKey = (section: TrackedSection, exerciseId: string, setNumber: number) => `removed|${section}|${exerciseId}|${setNumber}`;
// The note on the whole session (workout_sessions.note): one row, one key.
const SESSION_NOTE_KEY = 'session-note';
// This sitting's exercise order (workout_sessions.exercise_order): one key;
// the send reads the whole order from the model.
const ORDER_KEY = 'exercise-order';

/** The per-set metadata a row control edits: RPE text, the warm-up flag, and a pitch's style and attempts. */
export type SetMetaPatch = Partial<Pick<TrackedSet, 'rpe' | 'isWarmup' | 'ascentStyle' | 'attempts'>>;

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
 * with debounced autosave (flushed on tab hide; a failed save keeps the edits
 * dirty and retries — lib/tracking/saveQueue), the elapsed timer, and the
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
  const [saveState, setSaveState] = useState<TrackerSaveState>(IDLE_SAVE_STATE);
  const [sessionNote, setSessionNote] = useState('');

  const groupsRef = useRef<TrackedSectionGroup[]>([]);
  // Read by the send like groupsRef; written in the change handler itself so
  // the debounced send never carries a keystroke-old note.
  const sessionNoteRef = useRef('');
  // The one source of truth for what is unsaved. Created per session load,
  // disposed on cancel; null between sessions, when there is nothing to save.
  const queueRef = useRef<SaveQueue | null>(null);
  // The hidden-tab flush marks its send so the request can outlive the page.
  const keepaliveRef = useRef(false);
  // While the cancel request is out nothing is sent: a save landing after
  // the delete would re-create rows. Mirrors isCancelling for the callbacks.
  const cancellingRef = useRef(false);
  // What the server last reported for this session — bootstrap for a
  // finished session, or the finish response — so reopening the summary
  // costs nothing.
  const recordsRef = useRef<{ prs: PersonalRecord[]; scoreRecord: WorkoutScoreRecord | null }>({ prs: [], scoreRecord: null });
  // The unit a bare weight is sent with, null while it is not known. Read by
  // the send like groupsRef, so a queued send uses the current profile.
  const { profile } = useAuth();
  const unitContextRef = useRef<WeightContext | null>(null);
  useEffect(() => { unitContextRef.current = knownUnitContext(profile); }, [profile]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Save queue ──────────────────────────────────────────────────────────────

  // One send: the rows for these keys, read from the current model, in the
  // shape the server's `save` op takes. A key whose row is gone (a set
  // removed before its save landed) contributes nothing and is still
  // cleared by the queue on success. A failure's toast, if any, is
  // autosaveFailureToast's call; the bar carries the state after that.
  //
  // While the cancel request is out nothing may leave — a save landing
  // after the delete would re-create rows — and the callers that start a
  // send are gated on `cancellingRef`, but a send the queue starts on its
  // own (a backoff retry, the follow-up to an in-flight send, an isolation
  // pass) is not. So the send itself refuses, as a transient failure: the
  // keys stay pending for the queue a failed cancel leaves behind.
  const buildSend = (eventId: string, eventDate: string, queue: () => SaveQueue) => async (keys: readonly string[]) => {
    if (cancellingRef.current) throw new Error('Not sent: the workout is being cancelled');
    const setLogs: SetLogRow[] = [];
    const cardioLogs: CardioLogRow[] = [];
    const exerciseNotes: ExerciseNoteEdit[] = [];
    const removedSets: RemovedSetKey[] = [];
    let sessionNoteEdit: string | undefined;
    let exerciseOrderEdit: ExerciseOrder | undefined;
    const find = (section: string, exerciseId: string) =>
      groupsRef.current.find(g => g.section === section)?.exercises.find(t => t.exercise.id === exerciseId);
    for (const key of keys) {
      const [kind, section, exerciseId, setNumberStr] = key.split('|') as [string, TrackedSection, string, string | undefined];
      const tracked = find(section, exerciseId);
      if (kind === 'set') {
        const setNumber = Number(setNumberStr);
        const set = tracked?.sets.find(s => s.setNumber === setNumber);
        // A row can leave before its field's blur suffixes it (autosave
        // mid-typing, a tab hide, Finish while focused): it carries its unit
        // anyway.
        if (tracked && set) {
          setLogs.push(rowWithExplicitUnit(
            setToRow(eventId, eventDate, tracked, set), unitContextRef.current, tracked.exercise.category === 'climbing',
          ));
        }
      } else if (kind === 'cardio') {
        if (tracked?.cardio) cardioLogs.push(cardioToRow(eventId, eventDate, tracked));
      } else if (kind === 'note') {
        if (tracked) exerciseNotes.push({ section, exerciseId, note: tracked.sessionNote });
      } else if (kind === 'removed') {
        removedSets.push({ section, exerciseId, setNumber: Number(setNumberStr) });
      } else if (kind === SESSION_NOTE_KEY) {
        sessionNoteEdit = sessionNoteRef.current;
      } else if (kind === ORDER_KEY) {
        exerciseOrderEdit = exerciseOrderOf(groupsRef.current);
      }
    }
    if (
      !setLogs.length && !cardioLogs.length && !removedSets.length && !exerciseNotes.length &&
      sessionNoteEdit === undefined && exerciseOrderEdit === undefined
    ) return;
    const keepalive = keepaliveRef.current;
    keepaliveRef.current = false;
    const firstOfStreak = queue().state().consecutiveFailures === 0;
    try {
      await saveLogs(eventId, eventDate, {
        setLogs, cardioLogs, removedSets, exerciseNotes, sessionNote: sessionNoteEdit, exerciseOrder: exerciseOrderEdit,
      }, { keepalive });
    } catch (err) {
      const toast = autosaveFailureToast(err, keys, firstOfStreak);
      if (toast) notify(toast);
      throw err;
    }
  };

  const makeQueue = (eventId: string, eventDate: string): SaveQueue => {
    const queue: SaveQueue = createSaveQueue({
      send: buildSend(eventId, eventDate, () => queue),
      // A refused delete has no field to re-edit: the server kept the row,
      // the model no longer shows it, and a refusal nobody can act on must
      // not block Finish — the queue drops it instead of counting it.
      ignoreRejected: key => key.startsWith('removed|'),
      onChange: state => {
        // A superseded queue's last send may settle after its replacement
        // exists; only the live queue paints the state.
        if (queueRef.current === queue) setSaveState({ ...state, pausedStatus: queue.pausedStatus() });
      },
    });
    return queue;
  };

  // ── Load: get-or-create the session, hydrate any previously-saved logs ─────

  useEffect(() => {
    if (!eventId || !eventDate) return;
    const loadEvent = eventRef.current;
    if (!loadEvent) return;
    let cancelled = false;

    queueRef.current = makeQueue(eventId, eventDate);
    setSaveState({ ...queueRef.current.state(), pausedStatus: null });

    loadSession(loadEvent).then(data => {
      if (cancelled) return;
      setSession(data.session);
      recordsRef.current = { prs: data.prs, scoreRecord: data.scoreRecord };
      sessionNoteRef.current = data.session.note ?? '';
      setSessionNote(sessionNoteRef.current);
      setGroups(data.groups);
    });

    return () => {
      cancelled = true;
      queueRef.current?.dispose();
    };
    // makeQueue closes over refs only; the primitives are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      saveState,
      summary: summary && {
        prs: summary.prs,
        coachStatus: summary.coachStatus,
        coachText: summary.coachText,
      },
    }));
  }, [event, session, groups, summary, saveState]);

  // ── Autosave ────────────────────────────────────────────────────────────────

  /**
   * Send everything unsaved now. Resolves true once every edit pending at
   * the call is on the server, false when that attempt failed — the edits
   * stay dirty and the queue keeps retrying.
   */
  const flushSave = useCallback((): Promise<boolean> => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (cancellingRef.current) return Promise.resolve(true);
    return queueRef.current?.flush() ?? Promise.resolve(true);
  }, []);

  /** The queue's state right now — the React copy lags by a render. */
  const getSaveState = useCallback((): TrackerSaveState => {
    const queue = queueRef.current;
    return queue ? { ...queue.state(), pausedStatus: queue.pausedStatus() } : IDLE_SAVE_STATE;
  }, []);

  /** The Unsaved bar's Retry: cancels the scheduled retry and sends now. */
  const retrySave = useCallback((): Promise<boolean> => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    return queueRef.current?.retryNow() ?? Promise.resolve(true);
  }, []);

  const scheduleSave = useCallback(() => {
    if (cancellingRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush pending edits when the tab is backgrounded or closed mid-workout.
  // Keepalive lets that one request outlive the page; a retry cannot. The
  // flag covers only the send this flush issues: it is consumed by that
  // send, and cleared here in case the flush sent nothing.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden' || cancellingRef.current) return;
      keepaliveRef.current = true;
      flushSave().finally(() => { keepaliveRef.current = false; });
    };
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

  // A set and its removal are one server row: dirtying one drops the other,
  // so a batch never carries both a delete and an upsert of the same key —
  // the server runs its ops concurrently and would not order them.
  const markSetDirty = (section: TrackedSection, exerciseId: string, setNumber: number) => {
    queueRef.current?.unmark(removedKey(section, exerciseId, setNumber));
    queueRef.current?.markDirty(setKey(section, exerciseId, setNumber));
  };
  const markSetRemoved = (section: TrackedSection, exerciseId: string, setNumber: number) => {
    queueRef.current?.unmark(setKey(section, exerciseId, setNumber));
    queueRef.current?.markDirty(removedKey(section, exerciseId, setNumber));
  };

  const onSetChange = (section: TrackedSection, exerciseId: string, setNumber: number, field: SetField, value: string) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      sets: t.sets.map(s => (s.setNumber === setNumber ? { ...s, [field]: value } : s)),
    }));
    markSetDirty(section, exerciseId, setNumber);
    scheduleSave();
  };

  const onCardioChange = (section: TrackedSection, exerciseId: string, field: CardioField, value: string) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      cardio: t.cardio && { ...t.cardio, [field]: value },
    }));
    queueRef.current?.markDirty(cardioKey(section, exerciseId));
    scheduleSave();
  };

  // This occurrence only — it never touches the plan entry's notes.
  const onNoteChange = (section: TrackedSection, exerciseId: string, note: string) => {
    updateExercise(section, exerciseId, t => ({ ...t, sessionNote: note }));
    queueRef.current?.markDirty(noteKey(section, exerciseId));
    scheduleSave();
  };

  // The note on the whole session (phase55): its own key, its own column.
  /**
   * Move an exercise within its section for this sitting only: the order
   * saves on the session (phase60), never on the plan, so a series keeps its
   * own order on every other day.
   */
  const onReorderExercise = (section: TrackedSection, from: number, to: number) => {
    // A tap on the grip, or a drop where it started, moves nothing: write
    // nothing, so the session keeps following the plan's order.
    if (moveTrackedExercise(groupsRef.current, section, from, to) === groupsRef.current) return;
    setGroups(prev => prev && moveTrackedExercise(prev, section, from, to));
    queueRef.current?.markDirty(ORDER_KEY);
    scheduleSave();
  };

  const onSessionNoteChange = (note: string) => {
    sessionNoteRef.current = note;
    setSessionNote(note);
    queueRef.current?.markDirty(SESSION_NOTE_KEY);
    scheduleSave();
  };

  // RPE and the warm-up flag ride the set's own row, so they dirty the same
  // key as its reps — one upsert carries whatever changed.
  const onSetMetaChange = (section: TrackedSection, exerciseId: string, setNumber: number, patch: SetMetaPatch) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      sets: t.sets.map(s => (s.setNumber === setNumber ? { ...s, ...patch } : s)),
    }));
    markSetDirty(section, exerciseId, setNumber);
    scheduleSave();
  };

  /**
   * Correct when a finished session started and finished (R4.1–R4.5 are
   * the server's; offline the edit applies in memory). Resolves true once
   * the session carries the new times; a refusal toasts the server's own
   * reason and resolves false.
   */
  const editTimes = async (startedAt: string, finishedAt: string): Promise<boolean> => {
    const target = eventRef.current;
    if (!target || !isFinished) return false;
    try {
      const result = await editSessionTimes(target.id, target.date, startedAt, finishedAt);
      const times = result ?? {
        startedAt,
        finishedAt,
        totalDurationSeconds: Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)),
      };
      setSession(prev => prev && {
        ...prev,
        started_at: times.startedAt,
        finished_at: times.finishedAt,
        total_duration_seconds: times.totalDurationSeconds,
      });
      notify('Workout times updated');
      return true;
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : 'try again';
      notify(`Times not changed — ${reason.slice(0, 160)}`);
      return false;
    }
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
    markSetDirty(section, exerciseId, setNumber);
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
    queueRef.current?.markDirty(cardioKey(section, exerciseId));
    scheduleSave();
  };

  const onAddSet = (section: TrackedSection, exerciseId: string) => {
    updateExercise(section, exerciseId, t => {
      const next = t.sets.length ? Math.max(...t.sets.map(s => s.setNumber)) + 1 : 1;
      return { ...t, sets: [...t.sets, makeExtraSet(next)] };
    });
  };

  // An added exercise is nothing but its sets: removing the last one removes it.
  const dropEmptyAdded = (prev: TrackedSectionGroup[] | null) => prev && prev
    .map(g => ({ ...g, exercises: g.exercises.filter(t => !(t.isAdded && !t.isCardio && t.sets.length === 0)) }))
    .filter(g => g.exercises.length > 0);

  const onRemoveSet = (section: TrackedSection, exerciseId: string, setNumber: number) => {
    updateExercise(section, exerciseId, t => ({
      ...t,
      sets: t.sets.filter(s => !(s.isExtra && s.setNumber === setNumber)),
    }));
    setGroups(dropEmptyAdded);
    markSetRemoved(section, exerciseId, setNumber);
    scheduleSave();
  };

  /**
   * A movement the plan doesn't have — "pushups weren't in today's strength
   * session". Appended to the main section with one empty set; like any
   * extra set it persists once something is typed, and only for this day.
   */
  const onAddExercise = (def: ExerciseDefinition) => {
    const target = eventRef.current;
    if (!target) return;
    const added = makeAddedExercise('exercise', def);
    setGroups(prev => {
      if (!prev) return prev;
      if (prev.some(g => g.section === 'exercise')) {
        return prev.map(g => (g.section === 'exercise' ? { ...g, exercises: [...g.exercises, added] } : g));
      }
      const group = { section: 'exercise' as const, label: sectionLabels(target.type).exercises, exercises: [added] };
      const warmup = prev.findIndex(g => g.section === 'warmup');
      return [...prev.slice(0, warmup + 1), group, ...prev.slice(warmup + 1)];
    });
  };

  /** Take an added exercise back out: every set it logged is deleted. */
  const onRemoveAddedExercise = (section: TrackedSection, exerciseId: string) => {
    const tracked = findTracked(section, exerciseId);
    if (!tracked?.isAdded) return;
    const queue = queueRef.current;
    for (const set of tracked.sets) markSetRemoved(section, exerciseId, set.setNumber);
    // A cardio entry has no sets; any key naming the added id deletes its row.
    if (tracked.isCardio) queue?.markDirty(removedKey(section, exerciseId, 0));
    queue?.unmark(cardioKey(section, exerciseId));
    queue?.unmark(noteKey(section, exerciseId));
    setGroups(prev => prev && prev
      .map(g => (g.section !== section ? g : { ...g, exercises: g.exercises.filter(t => t.exercise.id !== exerciseId) }))
      .filter(g => g.exercises.length > 0));
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
    // it straight back over the rows the swap just relabelled. A flush that
    // failed leaves those rows dirty, so the swap waits for a save that works.
    if (!(await flushSave())) return false;

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
        // A resolved "80%" was a load for the old lift's max, not this one's.
        ...clearResolvedLoads(t),
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
    // Partials keep 'loading': the status turns 'ready' only when the stream
    // ends, which is when the server has saved coach_summary — the summary's
    // "Ask the coach" waits on that, since the ask reads the saved row.
    generateCoachSummary(event.id, event.date, partial => {
      setSummary(prev => prev && { ...prev, coachText: partial });
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
      // Unsaved edits never finish: the server would stamp the session over
      // rows it does not have. The queue keeps retrying; Finish is a retry.
      // Refused edits block it too — the numbers on screen are not the
      // numbers on the server until they are edited again and accepted.
      // A paused queue retries nothing on its own, so that toast names
      // what the user has to do first.
      const ok = await flushSave();
      const { rejected: refused, paused, pausedStatus } = getSaveState();
      if (!ok || refused > 0) {
        notify(
          ok ? refusedMessage(refused)
            : paused ? `Unsaved changes — ${pauseCause(pausedStatus)}, then Retry`
            : 'Unsaved changes — finish once they save',
        );
        setIsFinishing(false);
        return { status: 'failed' };
      }
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

    // The debounced autosave is dropped now; the queue is disposed only once
    // the delete has happened, so a failed cancel leaves the session with
    // its edits still queued (and anything typed during the request lands
    // on that same queue). Disposing is what blocks the visibilitychange
    // flush from re-creating rows after the delete.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    cancellingRef.current = true;
    setIsCancelling(true);
    try {
      await cancelSession(event.id, event.date);
      queueRef.current?.dispose();
      // A finished session set the completion flag — forgetting the workout
      // forgets that too. A never-finished session never completed anything.
      if (isFinished) setCompletion(event.id, false);
      return true;
    } catch {
      cancellingRef.current = false;
      setIsCancelling(false);
      // The debounce was dropped above and every send during the request
      // was refused, so an edit marked meanwhile has nothing armed for it:
      // re-arm the autosave rather than wait for the next edit or hide.
      if ((queueRef.current?.state().pending ?? 0) > 0) scheduleSave();
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
    saveState,
    sessionNote,
    onSetChange,
    onSetMetaChange,
    onSessionNoteChange,
    onReorderExercise,
    editTimes,
    onCardioChange,
    onCommitSetShadow,
    onCommitCardioShadow,
    onAddSet,
    onRemoveSet,
    onAddExercise,
    onRemoveAddedExercise,
    onSwapExercise,
    onNoteChange,
    flushSave,
    retrySave,
    getSaveState,
    requestFinish,
    cancelWorkout,
    openSavedSummary,
    dismissSummary,
  };
}
