import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dismissCoachAnnotation, listCoachAnnotations } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import { indexAnnotations, parseAnnotationList, type CoachAnnotation } from '../lib/coach/annotations';
import { registerAgentState } from '../dev/agentBridge';
import { useCalendar } from './calendar';
import { AnnotationsContext, visibleAnnotationRange, type AnnotationsContextValue } from './annotations';

// The coach's notes for whatever the calendar is showing. Sits inside
// CalendarProvider (App.tsx) so the visible range comes straight from the
// calendar's own state rather than being threaded through Calendar.tsx: one
// fetch per month step, none per view switch (visibleAnnotationRange).
//
// Fail-open, like every read the user did not ask for: a failed fetch is a
// console.warn (the API layer's) and an empty calendar of notes, never a
// toast and never a broken cell. Reads go through /api (service_role, scoped
// by user_id) because the table has RLS on with no policies — the anon
// client would see zero rows, so there is no realtime channel either;
// `refresh` is how a writer makes a new note appear.

const EMPTY: CoachAnnotation[] = [];

export function AnnotationsProvider({ children }: { children: React.ReactNode }) {
  const { state } = useCalendar();
  const range = useMemo(() => visibleAnnotationRange(state.currentDate), [state.currentDate]);
  const [annotations, setAnnotations] = useState<CoachAnnotation[]>(EMPTY);

  // Month steps can outrun the network: a slow reply for the month the user
  // has already left must not overwrite the one they are looking at.
  const requestSeq = useRef(0);

  const load = useCallback(async (from: string, to: string) => {
    const seq = ++requestSeq.current;
    if (!supabase) {
      // Offline mode: no session, no notes, and nothing to warn about.
      setAnnotations(EMPTY);
      return;
    }
    let next: CoachAnnotation[] = EMPTY;
    try {
      next = parseAnnotationList(await listCoachAnnotations(from, to));
    } catch {
      // requestJson already logged the detail; this line says what the
      // failure means for the screen.
      console.warn('[apex] Coach notes unavailable — rendering none for', from, 'to', to);
    }
    if (seq === requestSeq.current) setAnnotations(next);
  }, []);

  useEffect(() => { load(range.from, range.to); }, [load, range.from, range.to]);

  const refresh = useCallback(() => load(range.from, range.to), [load, range.from, range.to]);

  // What the dismiss handler reads at click time — an effect-synced ref, not
  // React state, so a stale closure never restores a stale list.
  const annotationsRef = useRef(annotations);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);

  const dismiss = useCallback(async (id: string) => {
    const target = annotationsRef.current.find(a => a.id === id);
    if (!target) return;
    setAnnotations(prev => prev.filter(a => a.id !== id));
    try {
      await dismissCoachAnnotation(id);
    } catch {
      // The API layer toasted. Put the one chip back so the user can try
      // again — unless a reload has already brought it back itself.
      setAnnotations(prev => (prev.some(a => a.id === id) ? prev : [...prev, target]));
    }
  }, []);

  const index = useMemo(() => indexAnnotations(annotations), [annotations]);
  const byDay = useCallback((date: string) => index.day.get(date) ?? EMPTY, [index]);
  const byEvent = useCallback((id: string) => index.event.get(id) ?? EMPTY, [index]);
  const byBlock = useCallback((id: string) => index.block.get(id) ?? EMPTY, [index]);

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('annotations', () => ({
      range,
      annotations: annotations.map(a => ({
        id: a.id, target_kind: a.target_kind, target_id: a.target_id, severity: a.severity,
      })),
    }));
  }, [range, annotations]);

  const value = useMemo<AnnotationsContextValue>(
    () => ({ annotations, range, byDay, byEvent, byBlock, dismiss, refresh }),
    [annotations, range, byDay, byEvent, byBlock, dismiss, refresh],
  );

  return <AnnotationsContext.Provider value={value}>{children}</AnnotationsContext.Provider>;
}
