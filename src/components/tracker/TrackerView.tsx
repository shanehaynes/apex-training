import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, CheckCircle2, Flag, Trash2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { postJson } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';
import { formatElapsed } from '../../lib/time';
import type { CardioLogRow, SetLogRow, WorkoutSessionRow, TrackedSection } from '../../lib/db/types';
import { getWorkoutColor } from '../../utils/workoutColors';
import {
  buildTrackerModel,
  buildLastPerformance,
  collectUntouchedPlanned,
  makeExtraSet,
  setExerciseNames,
  cardioExerciseNames,
  setToRow,
  cardioToRow,
} from '../../lib/tracking/plan';
import type { LastPerformance, TrackedSectionGroup } from '../../lib/tracking/plan';
import { computeSessionPRs } from '../../lib/tracking/records';
import type { PersonalRecord } from '../../lib/tracking/records';
import { buildSessionRecap, generateCoachSummary } from '../../lib/coach/summary';
import TrackerExercise from './TrackerExercise';
import type { SetField, CardioField } from './TrackerExercise';
import WorkoutSummary from './WorkoutSummary';
import type { CoachStatus } from './WorkoutSummary';

const AUTOSAVE_DEBOUNCE_MS = 800;

interface RemovedSetKey {
  section: TrackedSection;
  exerciseId: string;
  setNumber: number;
}

interface SummaryState {
  prs: PersonalRecord[];
  coachText: string | null;
  coachStatus: CoachStatus;
}

export default function TrackerView() {
  const { state, dispatch } = useCalendar();
  const { setCompletion } = useSchedule();
  const event = state.trackingSession;

  const [groups, setGroups] = useState<TrackedSectionGroup[] | null>(null);
  const [lastByName, setLastByName] = useState<Map<string, LastPerformance>>(() => new Map());
  const [session, setSession] = useState<Pick<WorkoutSessionRow, 'started_at' | 'finished_at' | 'total_duration_seconds' | 'coach_summary'> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [summary, setSummary] = useState<SummaryState | null>(null);

  const groupsRef = useRef<TrackedSectionGroup[]>([]);
  const dirtySetsRef = useRef<Set<string>>(new Set());   // `${section}|${exerciseId}|${setNumber}`
  const dirtyCardioRef = useRef<Set<string>>(new Set()); // `${section}|${exerciseId}`
  const removedRef = useRef<RemovedSetKey[]>([]);
  // Raw prior set/cardio logs for this event's exercises — feed client-side
  // PR detection at Finish (never sent through the AI).
  const historyRef = useRef<SetLogRow[]>([]);
  const cardioHistoryRef = useRef<CardioLogRow[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set the moment a cancel is confirmed: blocks the debounced autosave and
  // the visibilitychange flush from re-creating rows after the delete.
  const cancelledRef = useRef(false);

  if (groups) groupsRef.current = groups;

  const color = event ? getWorkoutColor(event.type) : null;
  const isFinished = !!session?.finished_at;

  // ── Load: get-or-create the session, hydrate any previously-saved logs ─────

  useEffect(() => {
    if (!event) return;
    let cancelled = false;

    (async () => {
      if (!supabase) {
        // No backend configured — track in memory only, like completions do.
        setSession({ started_at: new Date().toISOString(), finished_at: null, total_duration_seconds: null, coach_summary: null });
        setGroups(buildTrackerModel(event));
        return;
      }

      // Previous actuals for this event's set-tracked exercises, matched by
      // name so history follows an exercise across events. Ordered desc so a
      // truncated result still contains the most recent sessions.
      const names = setExerciseNames(event);
      const historyQuery = names.length
        ? supabase
            .from('workout_set_logs')
            .select('*')
            .in('exercise_name', names)
            .lt('event_date', event.date)
            .eq('is_autofilled', false)
            .order('event_date', { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [] as SetLogRow[] });

      // Prior cardio actuals, for distance/elevation PR detection.
      const cardioNames = cardioExerciseNames(event);
      const cardioHistoryQuery = cardioNames.length
        ? supabase
            .from('workout_cardio_logs')
            .select('*')
            .in('exercise_name', cardioNames)
            .lt('event_date', event.date)
            .order('event_date', { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [] as CardioLogRow[] });

      const [startRes, setsRes, cardioRes, historyRes, cardioHistoryRes] = await Promise.all([
        postJson<{ session: WorkoutSessionRow }>(
          '/api/workout-sessions',
          { action: 'start', eventId: event.id, eventDate: event.date },
          'Starting session',
        ),
        supabase.from('workout_set_logs').select('*').eq('event_id', event.id).eq('event_date', event.date),
        supabase.from('workout_cardio_logs').select('*').eq('event_id', event.id).eq('event_date', event.date),
        historyQuery,
        cardioHistoryQuery,
      ]).catch(err => {
        console.warn('[apex] Tracker load failed:', err);
        return [null, null, null, null, null] as const;
      });

      if (cancelled) return;

      if (startRes?.session) {
        setSession(startRes.session as WorkoutSessionRow);
      } else {
        setSession({ started_at: new Date().toISOString(), finished_at: null, total_duration_seconds: null, coach_summary: null });
      }
      historyRef.current = (historyRes?.data ?? []) as SetLogRow[];
      cardioHistoryRef.current = (cardioHistoryRes?.data ?? []) as CardioLogRow[];
      setLastByName(buildLastPerformance(historyRef.current));
      setGroups(buildTrackerModel(
        event,
        (setsRes?.data ?? []) as SetLogRow[],
        (cardioRes?.data ?? []) as CardioLogRow[],
      ));
    })();

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

  // ── Autosave ────────────────────────────────────────────────────────────────

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (!event || !supabase || cancelledRef.current) return;

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

    await postJson(
      '/api/workout-sessions',
      { action: 'save', eventId: event.id, eventDate: event.date, setLogs, cardioLogs, removedSets },
      'Autosave',
    ).catch(() => {});
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

  // ── Finish / cancel / close ─────────────────────────────────────────────────

  const close = async () => {
    await flushSave();
    dispatch({ type: 'STOP_TRACKING' });
  };

  const cancelWorkout = async () => {
    if (!event || isCancelling) return;

    cancelledRef.current = true;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    dirtySetsRef.current = new Set();
    dirtyCardioRef.current = new Set();
    removedRef.current = [];

    setIsCancelling(true);
    try {
      if (supabase) {
        await postJson(
          '/api/workout-sessions',
          { action: 'cancel', eventId: event.id, eventDate: event.date },
          'Discarding workout',
        );
      }
      // A finished session set the completion flag — forgetting the workout
      // forgets that too. A never-finished session never completed anything.
      if (isFinished) setCompletion(event.id, false);
      dispatch({ type: 'STOP_TRACKING' });
    } catch {
      cancelledRef.current = false;
      setIsCancelling(false);
      setConfirmCancel(false);
    }
  };

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
        if (supabase) {
          postJson(
            '/api/workout-sessions',
            { action: 'summary', eventId: event.id, eventDate: event.date, coachSummary: text },
            'Saving coach summary',
          ).catch(() => {});
        }
      })
      .catch(err => {
        console.warn('[apex] Coach summary generation failed:', err);
        setSummary(prev => prev && { ...prev, coachStatus: 'unavailable' });
      });
  };

  const finish = async () => {
    if (!event || !groups || isFinishing) return;

    const autofillRows = collectUntouchedPlanned(event.id, event.date, groups);
    if (confirmCount === null && autofillRows.length > 0) {
      setConfirmCancel(false);
      setConfirmCount(autofillRows.length);
      return;
    }

    setIsFinishing(true);
    try {
      await flushSave();
      let totalSeconds: number | null = elapsed;
      if (supabase) {
        const data = await postJson<{ totalDurationSeconds?: number }>(
          '/api/workout-sessions',
          { action: 'finish', eventId: event.id, eventDate: event.date, autofillRows },
          'Finishing workout',
        );
        if (typeof data?.totalDurationSeconds === 'number') totalSeconds = data.totalDurationSeconds;
      }
      setCompletion(event.id, true);
      setSession(prev => prev && {
        ...prev,
        finished_at: new Date().toISOString(),
        total_duration_seconds: totalSeconds,
      });
      setIsFinishing(false);
      setConfirmCount(null);

      // Summary popup before returning to the calendar: PRs are computed
      // here, client-side; the coach text streams in behind the popup.
      const prs = computeSessionPRs(groupsRef.current, historyRef.current, cardioHistoryRef.current);
      setSummary({ prs, coachText: null, coachStatus: 'loading' });
      generateAndSaveSummary(groupsRef.current, prs, totalSeconds);
    } catch {
      setIsFinishing(false);
      setConfirmCount(null);
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

  if (!event || !color) return null;

  return createPortal(
    <div className="tracker">
      <header className="tracker-header" style={{ borderBottom: `2px solid ${color.solid}` }}>
        <button className="tracker-header__back" onClick={close} aria-label="Back to calendar">
          <ChevronLeft size={20} strokeWidth={1.5} />
        </button>
        <div className="tracker-header__titles">
          <span className="tracker-header__title">{event.title}</span>
          <span className="tracker-header__date">{format(parseISO(event.date), 'EEEE, MMM d')}</span>
        </div>
        <span className={`tracker-header__timer${isFinished ? ' tracker-header__timer--done' : ''}`}>
          {formatElapsed(elapsed)}
        </span>
        {isFinished ? (
          <button
            className="tracker-header__done-badge tracker-header__done-badge--button"
            style={{ color: color.solid }}
            onClick={openSavedSummary}
            disabled={!groups}
            title="View workout summary"
          >
            <CheckCircle2 size={15} strokeWidth={2} /> Done
          </button>
        ) : (
          <button
            className="tracker-header__finish"
            style={{ background: color.solid }}
            onClick={finish}
            disabled={!groups || isFinishing}
          >
            <Flag size={14} strokeWidth={2} /> Finish
          </button>
        )}
      </header>

      <div className="tracker-body">
        {!groups ? (
          <p className="tracker-loading">Loading session…</p>
        ) : (
          groups.map(group => (
            <div key={group.section} className="modal-section">
              <div className="modal-section__header">
                <span className="modal-section__line" />
                <span className="modal-section__label">{group.label}</span>
                <span className="modal-section__line" />
              </div>
              {group.exercises.map(tracked => (
                <TrackerExercise
                  key={tracked.exercise.id}
                  tracked={tracked}
                  accentColor={color.solid}
                  last={lastByName.get(tracked.exercise.name)}
                  onSetChange={(setNumber, field, value) => onSetChange(group.section, tracked.exercise.id, setNumber, field, value)}
                  onCardioChange={(field, value) => onCardioChange(group.section, tracked.exercise.id, field, value)}
                  onAddSet={() => onAddSet(group.section, tracked.exercise.id)}
                  onRemoveSet={setNumber => onRemoveSet(group.section, tracked.exercise.id, setNumber)}
                />
              ))}
            </div>
          ))
        )}
        {groups && (
          <button
            className="tracker-cancel"
            onClick={() => { setConfirmCount(null); setConfirmCancel(true); }}
            disabled={isFinishing || isCancelling}
          >
            <Trash2 size={14} strokeWidth={1.5} /> Cancel workout
          </button>
        )}
      </div>

      {confirmCount !== null && !isFinishing && (
        <div className="tracker-confirm">
          <span className="tracker-confirm__msg">
            {confirmCount} planned {confirmCount === 1 ? 'set' : 'sets'} unlogged — recorded as 0.
          </span>
          <button className="tracker-confirm__cancel" onClick={() => setConfirmCount(null)}>Keep going</button>
          <button className="tracker-confirm__go" style={{ background: color.solid }} onClick={finish}>
            Finish anyway
          </button>
        </div>
      )}

      {summary && groups && (
        <WorkoutSummary
          event={event}
          accentColor={color.solid}
          durationSeconds={session?.total_duration_seconds ?? null}
          groups={groups}
          prs={summary.prs}
          coachText={summary.coachText}
          coachStatus={summary.coachStatus}
          onClose={() => setSummary(null)}
          onDone={() => { setSummary(null); dispatch({ type: 'STOP_TRACKING' }); }}
        />
      )}

      {confirmCancel && (
        <div className="tracker-confirm">
          <span className="tracker-confirm__msg">
            Cancel this workout? Everything logged for this session is deleted — it can't be resumed.
          </span>
          <button className="tracker-confirm__cancel" onClick={() => setConfirmCancel(false)} disabled={isCancelling}>
            Keep going
          </button>
          <button className="tracker-confirm__go tracker-confirm__go--danger" onClick={cancelWorkout} disabled={isCancelling}>
            {isCancelling ? 'Discarding…' : 'Discard workout'}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
