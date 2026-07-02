import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, CheckCircle2, Flag } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { supabase } from '../../lib/supabaseClient';
import type { CardioLogRow, SetLogRow, WorkoutSessionRow, TrackedSection } from '../../lib/supabaseClient';
import { getWorkoutColor } from '../../utils/workoutColors';
import {
  buildTrackerModel,
  collectUntouchedPlanned,
  makeExtraSet,
  setToRow,
  cardioToRow,
} from '../../lib/tracking/plan';
import type { TrackedSectionGroup } from '../../lib/tracking/plan';
import TrackerExercise from './TrackerExercise';
import type { SetField, CardioField } from './TrackerExercise';

const AUTOSAVE_DEBOUNCE_MS = 800;

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface RemovedSetKey {
  section: TrackedSection;
  exerciseId: string;
  setNumber: number;
}

export default function TrackerView() {
  const { state, dispatch } = useCalendar();
  const { setCompletion } = useSchedule();
  const event = state.trackingSession;

  const [groups, setGroups] = useState<TrackedSectionGroup[] | null>(null);
  const [session, setSession] = useState<Pick<WorkoutSessionRow, 'started_at' | 'finished_at' | 'total_duration_seconds'> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);

  const groupsRef = useRef<TrackedSectionGroup[]>([]);
  const dirtySetsRef = useRef<Set<string>>(new Set());   // `${section}|${exerciseId}|${setNumber}`
  const dirtyCardioRef = useRef<Set<string>>(new Set()); // `${section}|${exerciseId}`
  const removedRef = useRef<RemovedSetKey[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setSession({ started_at: new Date().toISOString(), finished_at: null, total_duration_seconds: null });
        setGroups(buildTrackerModel(event));
        return;
      }

      const [startRes, setsRes, cardioRes] = await Promise.all([
        fetch('/api/workout-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', eventId: event.id, eventDate: event.date }),
        }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`start failed: ${r.status}`)))),
        supabase.from('workout_set_logs').select('*').eq('event_id', event.id).eq('event_date', event.date),
        supabase.from('workout_cardio_logs').select('*').eq('event_id', event.id).eq('event_date', event.date),
      ]).catch(err => {
        console.warn('[apex] Tracker load failed:', err);
        return [null, null, null] as const;
      });

      if (cancelled) return;

      if (startRes?.session) {
        setSession(startRes.session as WorkoutSessionRow);
      } else {
        setSession({ started_at: new Date().toISOString(), finished_at: null, total_duration_seconds: null });
      }
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
    if (!event || !supabase) return;

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

    try {
      const res = await fetch('/api/workout-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', eventId: event.id, eventDate: event.date, setLogs, cardioLogs, removedSets }),
      });
      if (!res.ok) console.warn('[apex] Tracker autosave failed:', await res.text());
    } catch (err) {
      console.warn('[apex] Tracker autosave failed:', err);
    }
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

  // ── Finish / close ──────────────────────────────────────────────────────────

  const close = async () => {
    await flushSave();
    dispatch({ type: 'STOP_TRACKING' });
  };

  const finish = async () => {
    if (!event || !groups || isFinishing) return;

    const autofillRows = collectUntouchedPlanned(event.id, event.date, groups);
    if (confirmCount === null && autofillRows.length > 0) {
      setConfirmCount(autofillRows.length);
      return;
    }

    setIsFinishing(true);
    try {
      await flushSave();
      if (supabase) {
        const res = await fetch('/api/workout-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'finish', eventId: event.id, eventDate: event.date, autofillRows }),
        });
        if (!res.ok) {
          console.warn('[apex] Finish failed:', await res.text());
          setIsFinishing(false);
          setConfirmCount(null);
          return;
        }
      }
      setCompletion(event.id, true);
      dispatch({ type: 'STOP_TRACKING' });
    } catch (err) {
      console.warn('[apex] Finish failed:', err);
      setIsFinishing(false);
      setConfirmCount(null);
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
          <span className="tracker-header__done-badge" style={{ color: color.solid }}>
            <CheckCircle2 size={15} strokeWidth={2} /> Done
          </span>
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
                  onSetChange={(setNumber, field, value) => onSetChange(group.section, tracked.exercise.id, setNumber, field, value)}
                  onCardioChange={(field, value) => onCardioChange(group.section, tracked.exercise.id, field, value)}
                  onAddSet={() => onAddSet(group.section, tracked.exercise.id)}
                  onRemoveSet={setNumber => onRemoveSet(group.section, tracked.exercise.id, setNumber)}
                />
              ))}
            </div>
          ))
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
    </div>,
    document.body,
  );
}
