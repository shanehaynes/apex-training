// Drag a workout chip to another day (month view) or another time (week view)
// and the occurrence moves through ScheduleContext's rescheduleEvent — the
// same seam the modal's date and time chips use, so a failed move toasts the
// way those do and the chip stays where it was.
//
// Pointer events, mouse only. HTML5 drag-and-drop was rejected: it has no
// movement threshold (so the chip's click and complete buttons would fight
// it), it owns the drag image (no 15-minute snap preview), and it fires
// `dragover` on its own cadence. Pointer events give a 5px threshold, an
// Escape that cancels, and `pointerType` to leave touch alone — the native
// iOS app covers phones.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { minutesToDisplayTime, timeToMinutes } from '../../lib/time';
import { useSchedule } from '../../context/schedule';
import type { OccurrenceOverride } from '../../lib/schedule/types';
import type { WorkoutEvent } from '../../types/workout';
import '../../styles/calendar-drag.css';

/** Pointer travel before a press becomes a drag; under it, it is a click. */
export const DRAG_THRESHOLD_PX = 5;
/** Week view snaps the dropped start to this grain. */
export const SNAP_MINUTES = 15;

/** The week grid's geometry — WeekView draws with these, the drag reads them. */
export const WEEK_GRID = {
  /** 5 AM, in minutes since midnight. */
  dayStart: 5 * 60,
  /** 18 hour rows: 5 AM through the 10 PM row, ending at 11 PM. */
  hours: 18,
  /** px per hour. */
  slotHeight: 56,
} as const;

export const WEEK_DAY_END = WEEK_GRID.dayStart + WEEK_GRID.hours * 60;

/** Day cells and week columns carry this attribute with their yyyy-MM-dd key. */
export const DROP_DATE_ATTR = 'data-drop-date';

// ─── Pure geometry (unit-tested; no DOM) ─────────────────────────────────────

export function exceedsThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

export function snapMinutes(minutes: number, step = SNAP_MINUTES): number {
  return Math.round(minutes / step) * step;
}

/**
 * The span a move preserves: end − start when the event has both, otherwise
 * its estimate (which is also what sizes the week block).
 */
export function eventDurationMinutes(event: Pick<WorkoutEvent, 'startTime' | 'endTime' | 'estimatedDuration'>): number {
  const start = timeToMinutes(event.startTime);
  const end = timeToMinutes(event.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
  return Math.max(0, event.estimatedDuration || 0);
}

/**
 * Start minute for a block whose top edge sits `blockTopPx` in the viewport,
 * in a column whose top edge is `columnTopPx`: snapped to the grain and
 * clamped so the whole block stays inside the grid.
 */
export function weekStartMinutes(blockTopPx: number, columnTopPx: number, durationMinutes: number): number {
  const raw = WEEK_GRID.dayStart + ((blockTopPx - columnTopPx) / WEEK_GRID.slotHeight) * 60;
  const latest = Math.max(WEEK_GRID.dayStart, WEEK_DAY_END - durationMinutes);
  return Math.min(Math.max(snapMinutes(raw), WEEK_GRID.dayStart), latest);
}

/** Minutes since midnight → px from the column's top. */
export function weekMinutesToTop(minutes: number): number {
  return ((minutes - WEEK_GRID.dayStart) / 60) * WEEK_GRID.slotHeight;
}

/** Month drop: only the date moves; the same day is a no-op (null). */
export function monthDropFields(event: Pick<WorkoutEvent, 'date'>, date: string): OccurrenceOverride | null {
  return date === event.date ? null : { date };
}

/**
 * Week drop: date + snapped start, and an end that keeps the duration when
 * the event has one. Nothing changed → null, so no request goes out.
 */
export function weekDropFields(
  event: Pick<WorkoutEvent, 'date' | 'startTime' | 'endTime' | 'estimatedDuration'>,
  date: string,
  startMinutes: number,
): OccurrenceOverride | null {
  if (date === event.date && timeToMinutes(event.startTime) === startMinutes) return null;
  const fields: OccurrenceOverride = { date, startTime: minutesToDisplayTime(startMinutes) };
  if (event.endTime && Number.isFinite(timeToMinutes(event.endTime))) {
    fields.endTime = minutesToDisplayTime(startMinutes + eventDurationMinutes(event));
  }
  return fields;
}

// ─── Drop-target store ───────────────────────────────────────────────────────
// One drag at a time, so one module-level target. Cells and columns subscribe
// by date and re-render only when they become (or stop being) the target.

let dropTarget: string | null = null;
const listeners = new Set<() => void>();

function setDropTarget(date: string | null) {
  if (date === dropTarget) return;
  dropTarget = date;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True while a dragged chip hovers the cell or column keyed `dateKey`. */
export function useIsDropTarget(dateKey: string): boolean {
  return useSyncExternalStore(subscribe, () => dropTarget === dateKey, () => false);
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface WeekPreview {
  date: string;
  startMinutes: number;
  /** Translate from the block's laid-out position to the snapped target. */
  dx: number;
  dy: number;
}

interface Session {
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer offset from the chip's top edge — keeps the grab point fixed. */
  grabOffsetY: number;
  /** The chip's own column/cell, for the week translate and the no-op check. */
  originEl: HTMLElement;
  active: boolean;
  cancelled: boolean;
  /** What a drop would commit, updated on every move. */
  drop: { date: string; startMinutes?: number } | null;
}

interface Options {
  event: WorkoutEvent;
  view: 'month' | 'week';
}

export interface DragReschedule {
  dragging: boolean;
  /** Week view only: where the block would land, for the live label and translate. */
  preview: WeekPreview | null;
  style: CSSProperties | undefined;
  handlers: { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void };
}

function findWeekColumn(x: number): HTMLElement | null {
  const cols = document.querySelectorAll<HTMLElement>(`.week-view__day-col[${DROP_DATE_ATTR}]`);
  for (const col of cols) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x < r.right) return col;
  }
  return null;
}

function findMonthCell(x: number, y: number): HTMLElement | null {
  // The dragged chip sits in its own cell (cells clip, so it never floats
  // over another), so whatever is under the pointer resolves to the right cell.
  const el = document.elementFromPoint(x, y);
  return el ? el.closest<HTMLElement>(`.day-cell[${DROP_DATE_ATTR}]`) : null;
}

/**
 * Swallow the click the browser synthesises after a drag's pointerup. It
 * lands on the common ancestor of press and release — a day cell (which
 * would open the day) or the chip's own button (which would open the modal).
 */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  // The click is dispatched in the same input task as the pointerup; a timer
  // runs after it, so a drop with no click (released off-window) does not
  // leave the next real click swallowed.
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

export function useDragReschedule({ event, view }: Options): DragReschedule {
  const { rescheduleEvent } = useSchedule();
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<WeekPreview | null>(null);
  const session = useRef<Session | null>(null);
  // The drop reads the event as it is at release time, not at press time.
  const eventRef = useRef(event);
  useEffect(() => { eventRef.current = event; }, [event]);

  const finish = useCallback((commit: boolean) => {
    const s = session.current;
    if (!s) return;
    if (s.active) {
      document.body.classList.remove('calendar-dragging');
      setDropTarget(null);
      setDragging(false);
      setPreview(null);
      if (commit && s.drop && !s.cancelled) {
        const ev = eventRef.current;
        const fields = view === 'month'
          ? monthDropFields(ev, s.drop.date)
          : s.drop.startMinutes === undefined ? null : weekDropFields(ev, s.drop.date, s.drop.startMinutes);
        // Fire and forget: the API client toasts a failure, and the schedule
        // only moves the event locally once the server agreed.
        if (fields) void rescheduleEvent(ev.id, fields);
      }
    }
    session.current = null;
  }, [rescheduleEvent, view]);

  // Window listeners live for the press; `finish` tears the session down.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId || s.cancelled) return;
      if (!s.active) {
        if (!exceedsThreshold(e.clientX - s.startX, e.clientY - s.startY)) return;
        s.active = true;
        document.body.classList.add('calendar-dragging');
        setDragging(true);
      }
      if (view === 'month') {
        const cell = findMonthCell(e.clientX, e.clientY);
        const date = cell?.getAttribute(DROP_DATE_ATTR) ?? null;
        s.drop = date ? { date } : null;
        setDropTarget(date);
        return;
      }
      const col = findWeekColumn(e.clientX);
      if (!col) {
        s.drop = null;
        setDropTarget(null);
        setPreview(null);
        return;
      }
      const date = col.getAttribute(DROP_DATE_ATTR) ?? '';
      const colRect = col.getBoundingClientRect();
      const originRect = s.originEl.getBoundingClientRect();
      const ev = eventRef.current;
      const startMinutes = weekStartMinutes(e.clientY - s.grabOffsetY, colRect.top, eventDurationMinutes(ev));
      s.drop = { date, startMinutes };
      setDropTarget(date);
      setPreview({
        date,
        startMinutes,
        dx: colRect.left - originRect.left,
        dy: weekMinutesToTop(startMinutes) - weekMinutesToTop(timeToMinutes(ev.startTime)),
      });
    };
    const onUp = (e: PointerEvent) => {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId) return;
      const wasDrag = s.active || s.cancelled;
      finish(true);
      if (wasDrag) swallowNextClick();
    };
    const onKey = (e: KeyboardEvent) => {
      const s = session.current;
      if (!s || !s.active || e.key !== 'Escape') return;
      // Visuals reset now; the press ends on its own pointerup, which is
      // then a no-op that still swallows the synthetic click.
      s.cancelled = true;
      document.body.classList.remove('calendar-dragging');
      setDropTarget(null);
      setDragging(false);
      setPreview(null);
      s.active = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      if (session.current?.active) {
        document.body.classList.remove('calendar-dragging');
        setDropTarget(null);
      }
      session.current = null;
    };
  }, [finish, view]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || session.current) return;
    const originEl = e.currentTarget.closest<HTMLElement>(`[${DROP_DATE_ATTR}]`);
    if (!originEl) return;
    const rect = e.currentTarget.getBoundingClientRect();
    session.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabOffsetY: e.clientY - rect.top,
      originEl,
      active: false,
      cancelled: false,
      drop: null,
    };
  }, []);

  const style: CSSProperties | undefined = preview
    ? { transform: `translate(${preview.dx}px, ${preview.dy}px)` }
    : undefined;

  return { dragging, preview, style, handlers: { onPointerDown } };
}
