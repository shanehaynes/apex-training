import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { parseISO, isSameDay, addDays, format } from 'date-fns';
import scheduleData from '../data/schedule.json';
import { supabase } from '../lib/supabaseClient';
import type {
  CompletionRow,
  CompletionLogRow,
  WorkoutEventRow,
  EventMutationLogRow,
} from '../lib/supabaseClient';
import type { WorkoutEvent, Schedule, WorkoutType } from '../types/workout';

// ─── Recurring expansion ──────────────────────────────────────────────────────

function expandRecurringEvents(
  rawEvents: WorkoutEvent[],
  exceptions: Set<string>, // `${event_id}__${date}` pairs to skip
): WorkoutEvent[] {
  const existingDatesPerType = new Map<string, Set<string>>();
  for (const e of rawEvents) {
    if (!existingDatesPerType.has(e.type)) existingDatesPerType.set(e.type, new Set());
    existingDatesPerType.get(e.type)!.add(e.date);
  }

  const expanded: WorkoutEvent[] = [...rawEvents];

  for (const base of rawEvents) {
    if (!base.isRecurring || base.recurringPattern?.frequency !== 'daily') continue;
    const endDate = base.recurringPattern?.endDate;
    if (!endDate) continue;

    let cursor = addDays(parseISO(base.date), 1);
    const end = parseISO(endDate);
    while (cursor <= end) {
      const dateStr = format(cursor, 'yyyy-MM-dd');
      const instanceKey = `${base.id}__${dateStr}`;
      if (
        !existingDatesPerType.get(base.type)?.has(dateStr) &&
        !exceptions.has(instanceKey)
      ) {
        expanded.push({ ...base, id: instanceKey, date: dateStr, isCompleted: false });
        existingDatesPerType.get(base.type)!.add(dateStr);
      }
      cursor = addDays(cursor, 1);
    }
  }

  return expanded.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Row ↔ WorkoutEvent mapping ───────────────────────────────────────────────

function rowToEvent(row: WorkoutEventRow): WorkoutEvent {
  return {
    id:                row.id,
    type:              row.type as WorkoutType,
    title:             row.title,
    subtitle:          row.subtitle ?? undefined,
    date:              row.date,
    startTime:         row.start_time ?? undefined,
    endTime:           row.end_time ?? undefined,
    estimatedDuration: row.estimated_duration,
    description:       row.description,
    warmup:            (row.warmup ?? []) as WorkoutEvent['warmup'],
    exercises:         (row.exercises ?? []) as WorkoutEvent['exercises'],
    cooldown:          (row.cooldown ?? []) as WorkoutEvent['cooldown'],
    difficulty:        row.difficulty as WorkoutEvent['difficulty'],
    location:          row.location ?? undefined,
    coverImageUrl:     row.cover_image_url ?? undefined,
    tags:              row.tags ?? [],
    equipment:         row.equipment ?? [],
    isCompleted:       false,
    isRecurring:       row.is_recurring,
    recurringPattern:  row.recurring_frequency
      ? {
          frequency:  row.recurring_frequency as 'daily' | 'weekly' | 'custom',
          daysOfWeek: row.recurring_days ?? undefined,
          endDate:    row.recurring_end_date ?? undefined,
        }
      : undefined,
  };
}

export function eventToRow(
  e: Partial<WorkoutEvent> & Pick<WorkoutEvent, 'id' | 'type' | 'title' | 'date' | 'estimatedDuration' | 'difficulty' | 'isRecurring' | 'exercises' | 'tags' | 'description' | 'isCompleted'>,
): Omit<WorkoutEventRow, 'created_at' | 'updated_at'> {
  return {
    id:                  e.id,
    type:                e.type,
    title:               e.title,
    subtitle:            e.subtitle ?? null,
    date:                e.date,
    start_time:          e.startTime ?? null,
    end_time:            e.endTime ?? null,
    estimated_duration:  e.estimatedDuration,
    description:         e.description,
    warmup:              (e.warmup ?? []) as unknown[],
    exercises:           (e.exercises ?? []) as unknown[],
    cooldown:            (e.cooldown ?? []) as unknown[],
    difficulty:          e.difficulty,
    location:            e.location ?? null,
    cover_image_url:     e.coverImageUrl ?? null,
    tags:                e.tags ?? [],
    equipment:           e.equipment ?? [],
    is_recurring:        e.isRecurring,
    recurring_frequency: e.recurringPattern?.frequency ?? null,
    recurring_days:      e.recurringPattern?.daysOfWeek ?? null,
    recurring_end_date:  e.recurringPattern?.endDate ?? null,
  };
}

// ─── Completion persistence ───────────────────────────────────────────────────

const LS_KEY = 'apex-completed';

function lsLoad(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function lsSave(ids: Set<string>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...ids])); } catch {}
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CreateEventInput {
  type: WorkoutType;
  title: string;
  date: string;
  estimatedDuration: number;
  difficulty?: 1 | 2 | 3 | 4 | 5;
  startTime?: string;
  endTime?: string;
  description?: string;
  location?: string;
  tags?: string[];
  equipment?: string[];
  exercises?: WorkoutEvent['exercises'];
}

export interface UpdateEventInput {
  id: string;
  fields: Partial<Omit<WorkoutEvent, 'id' | 'isCompleted'>>;
}

interface ScheduleContextValue {
  events: WorkoutEvent[];
  isSyncing: boolean;
  isEventsLoading: boolean;
  getEventsForDate: (date: Date) => WorkoutEvent[];
  getEventsForRange: (start: Date, end: Date) => WorkoutEvent[];
  toggleCompletion: (id: string) => void;
  createEvent: (input: CreateEventInput) => Promise<{ id: string } | null>;
  updateEvent: (input: UpdateEventInput) => Promise<boolean>;
  deleteEvent: (id: string) => Promise<boolean>;
  deleteEventInstance: (baseId: string, date: string) => Promise<boolean>;
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ScheduleProvider({ children }: { children: React.ReactNode }) {
  const [baseEvents, setBaseEvents] = useState<WorkoutEvent[]>([]);
  const [exceptions, setExceptions] = useState<Set<string>>(new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(lsLoad);
  const [isSyncing, setIsSyncing] = useState(!!supabase);
  const [isEventsLoading, setIsEventsLoading] = useState(!!supabase);

  const eventsRef = useRef<WorkoutEvent[]>([]);

  // ── Fetch events from Supabase (or fall back to JSON) ──────────────────────

  const loadEvents = useCallback(async () => {
    if (!supabase) {
      setBaseEvents((scheduleData as Schedule).events as WorkoutEvent[]);
      setIsEventsLoading(false);
      return;
    }

    const [eventsRes, exceptionsRes] = await Promise.all([
      supabase.from('workout_events').select('*').order('date'),
      supabase.from('recurring_exceptions').select('event_id, skipped_date'),
    ]);

    if (eventsRes.error) {
      console.warn('[apex] Failed to load workout_events:', eventsRes.error.message);
      setBaseEvents((scheduleData as Schedule).events as WorkoutEvent[]);
    } else {
      setBaseEvents((eventsRes.data as WorkoutEventRow[]).map(rowToEvent));
    }

    if (!exceptionsRes.error && exceptionsRes.data) {
      const exSet = new Set(
        (exceptionsRes.data as { event_id: string; skipped_date: string }[]).map(
          r => `${r.event_id}__${r.skipped_date}`,
        ),
      );
      setExceptions(exSet);
    }

    setIsEventsLoading(false);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // ── Realtime: re-fetch whenever events or exceptions change ────────────────

  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel('schedule-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workout_events' }, loadEvents)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recurring_exceptions' }, loadEvents)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadEvents]);

  // ── Completion sync ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('workout_completions')
      .select('event_id')
      .eq('is_completed', true)
      .then(({ data, error }) => {
        if (error) {
          console.warn('[apex] Completion sync failed:', error.message);
        } else {
          const serverIds = new Set((data as Pick<CompletionRow, 'event_id'>[]).map(r => r.event_id));
          setCompletedIds(serverIds);
          lsSave(serverIds);
        }
        setIsSyncing(false);
      });
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const allExpanded = useMemo(
    () => expandRecurringEvents(baseEvents, exceptions),
    [baseEvents, exceptions],
  );

  const events = useMemo<WorkoutEvent[]>(
    () => allExpanded.map(e => ({ ...e, isCompleted: completedIds.has(e.id) })),
    [allExpanded, completedIds],
  );
  eventsRef.current = events;

  // ── Queries ────────────────────────────────────────────────────────────────

  const parseTime = (t?: string): number => {
    if (!t) return Infinity;
    const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return Infinity;
    let h = parseInt(m[1]);
    const min = parseInt(m[2]);
    if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
    if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  };

  const getEventsForDate = useMemo(
    () => (date: Date) =>
      events
        .filter(e => isSameDay(parseISO(e.date), date))
        .sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime)),
    [events],
  );

  const getEventsForRange = useMemo(
    () => (start: Date, end: Date) =>
      events.filter(e => { const d = parseISO(e.date); return d >= start && d <= end; }),
    [events],
  );

  // ── Completion toggle ──────────────────────────────────────────────────────

  const toggleCompletion = (id: string) => {
    const event = eventsRef.current.find(e => e.id === id);
    if (!event) return;

    const isNowCompleted = !completedIds.has(id);
    setCompletedIds(prev => {
      const next = new Set(prev);
      isNowCompleted ? next.add(id) : next.delete(id);
      lsSave(next);
      return next;
    });

    if (!supabase) return;

    const completionRow: CompletionRow = {
      event_id:         id,
      event_date:       event.date,
      event_type:       event.type,
      event_title:      event.title,
      duration_minutes: event.estimatedDuration ?? null,
      is_completed:     isNowCompleted,
      completed_at:     isNowCompleted ? new Date().toISOString() : null,
      updated_at:       new Date().toISOString(),
    };
    const logRow: CompletionLogRow = {
      event_id:         id,
      event_date:       event.date,
      event_type:       event.type,
      event_title:      event.title,
      duration_minutes: event.estimatedDuration ?? null,
      action:           isNowCompleted ? 'complete' : 'uncomplete',
    };

    Promise.all([
      supabase.from('workout_completions').upsert(completionRow),
      supabase.from('workout_completion_log').insert(logRow),
    ]).then(([{ error: upsertErr }, { error: logErr }]) => {
      if (upsertErr) console.warn('[apex] Completion upsert failed:', upsertErr.message);
      if (logErr)    console.warn('[apex] Completion log failed:', logErr.message);
    });
  };

  // ── Mutation helpers ───────────────────────────────────────────────────────

  async function logMutation(entry: EventMutationLogRow) {
    if (!supabase) return;
    const { error } = await supabase.from('event_mutations_log').insert(entry);
    if (error) console.warn('[apex] Mutation log failed:', error.message);
  }

  const createEvent = useCallback(async (input: CreateEventInput): Promise<{ id: string } | null> => {
    if (!supabase) return null;

    const id = `ai-${Date.now()}`;
    const newEvent: WorkoutEvent = {
      id,
      type:              input.type,
      title:             input.title,
      date:              input.date,
      estimatedDuration: input.estimatedDuration,
      difficulty:        input.difficulty ?? 3,
      startTime:         input.startTime,
      endTime:           input.endTime,
      description:       input.description ?? '',
      location:          input.location,
      tags:              input.tags ?? [],
      equipment:         input.equipment ?? [],
      exercises:         input.exercises ?? [],
      isCompleted:       false,
      isRecurring:       false,
    };

    const { error } = await supabase.from('workout_events').insert(eventToRow(newEvent));
    if (error) { console.warn('[apex] createEvent failed:', error.message); return null; }

    await logMutation({ operation: 'create', event_id: id, event_title: input.title, event_date: input.date });
    return { id };
  }, []);

  const updateEvent = useCallback(async ({ id, fields }: UpdateEventInput): Promise<boolean> => {
    if (!supabase) return false;

    const current = eventsRef.current.find(e => e.id === id);
    const baseId = id.includes('__') ? id.split('__')[0] : id;

    const dbFields: Partial<WorkoutEventRow> = {};
    if (fields.title             !== undefined) dbFields.title               = fields.title;
    if (fields.type              !== undefined) dbFields.type                = fields.type;
    if (fields.date              !== undefined) dbFields.date                = fields.date;
    if (fields.startTime         !== undefined) dbFields.start_time          = fields.startTime ?? null;
    if (fields.endTime           !== undefined) dbFields.end_time            = fields.endTime ?? null;
    if (fields.estimatedDuration !== undefined) dbFields.estimated_duration  = fields.estimatedDuration;
    if (fields.description       !== undefined) dbFields.description         = fields.description;
    if (fields.location          !== undefined) dbFields.location            = fields.location ?? null;
    if (fields.difficulty        !== undefined) dbFields.difficulty          = fields.difficulty;
    if (fields.tags              !== undefined) dbFields.tags                = fields.tags;
    if (fields.equipment         !== undefined) dbFields.equipment           = fields.equipment;
    if (fields.exercises         !== undefined) dbFields.exercises           = fields.exercises as unknown[];
    if (fields.warmup            !== undefined) dbFields.warmup              = fields.warmup as unknown[];
    if (fields.cooldown          !== undefined) dbFields.cooldown            = fields.cooldown as unknown[];

    const { error } = await supabase
      .from('workout_events')
      .update({ ...dbFields, updated_at: new Date().toISOString() })
      .eq('id', baseId);

    if (error) { console.warn('[apex] updateEvent failed:', error.message); return false; }

    await logMutation({
      operation:   'update',
      event_id:    baseId,
      event_title: fields.title ?? current?.title ?? baseId,
      event_date:  fields.date ?? current?.date,
      diff:        { before: current ?? {}, after: fields },
    });
    return true;
  }, []);

  const deleteEvent = useCallback(async (id: string): Promise<boolean> => {
    if (!supabase) return false;

    const event = eventsRef.current.find(e => e.id === id);
    const baseId = id.includes('__') ? id.split('__')[0] : id;

    const { error } = await supabase.from('workout_events').delete().eq('id', baseId);
    if (error) { console.warn('[apex] deleteEvent failed:', error.message); return false; }

    await logMutation({ operation: 'delete', event_id: baseId, event_title: event?.title ?? baseId, event_date: event?.date });
    return true;
  }, []);

  const deleteEventInstance = useCallback(async (baseId: string, date: string): Promise<boolean> => {
    if (!supabase) return false;

    const event = eventsRef.current.find(e => e.id === baseId || e.id.startsWith(baseId));
    const { error } = await supabase
      .from('recurring_exceptions')
      .insert({ event_id: baseId, skipped_date: date });

    if (error) { console.warn('[apex] deleteEventInstance failed:', error.message); return false; }

    await logMutation({ operation: 'delete_instance', event_id: baseId, event_title: event?.title ?? baseId, event_date: date });
    return true;
  }, []);

  return (
    <ScheduleContext.Provider value={{
      events,
      isSyncing,
      isEventsLoading,
      getEventsForDate,
      getEventsForRange,
      toggleCompletion,
      createEvent,
      updateEvent,
      deleteEvent,
      deleteEventInstance,
    }}>
      {children}
    </ScheduleContext.Provider>
  );
}

export function useSchedule() {
  const ctx = useContext(ScheduleContext);
  if (!ctx) throw new Error('useSchedule must be used within ScheduleProvider');
  return ctx;
}
