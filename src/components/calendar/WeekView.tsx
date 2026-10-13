import { useMemo, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, Circle } from 'lucide-react';
import { now, isToday } from '../../lib/clock';
import { buildWeekDays, toDateString } from '../../utils/dateHelpers';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useSchedule } from '../../context/schedule';
import { useCalendar } from '../../context/calendar';
import { useAnnotations } from '../../context/annotations';
import { useTip } from '../../hooks/useTip';
import { minutesToDisplayTime, timeToMinutes } from '../../lib/time';
import { layoutDayEvents } from '../../lib/schedule/weekLayout';
import { AnnotationMarker } from './AnnotationChip';
import { DROP_DATE_ATTR, WEEK_GRID, useDragReschedule, useIsDropTarget } from './useDragReschedule';
import type { WorkoutEvent } from '../../types/workout';
import './annotations.css';

// The grid's geometry lives with the drag hook, which turns a pointer
// position back into a time with the same numbers.
const SLOT_HEIGHT = WEEK_GRID.slotHeight; // px per hour
const DAY_START = WEEK_GRID.dayStart; // 5 AM in minutes
const HOURS = Array.from({ length: WEEK_GRID.hours }, (_, i) => i + DAY_START / 60); // 5 AM – 10 PM

interface EventBlockProps {
  event: WorkoutEvent;
  colIndex: number;
  colCount: number;
}

function EventBlock({ event, colIndex, colCount }: EventBlockProps) {
  const { dispatch } = useCalendar();
  const { toggleCompletion } = useSchedule();
  const { byEvent } = useAnnotations();
  // Notes read in the block's tooltip and are dismissed in the day view; a
  // week block is too small for a pill, and its click already opens the workout.
  const notes = byEvent(event.id);
  // Mouse drag moves the block: vertically in 15-minute steps (duration
  // kept), across columns to another day. Click still opens the workout.
  const drag = useDragReschedule({ event, view: 'week' });
  const color = getWorkoutColor(event.type);
  const top = event.startTime ? ((timeToMinutes(event.startTime) - DAY_START) / 60) * SLOT_HEIGHT : 0;
  const height = (event.estimatedDuration / 60) * SLOT_HEIGHT;
  // Compact mode: not enough vertical room to stack title + time
  const compact = height < 28;

  const GAP = 4;
  const colWidth = `calc((100% - ${GAP * (colCount + 1)}px) / ${colCount})`;
  const leftOffset = `calc(${GAP}px + (${colWidth} + ${GAP}px) * ${colIndex})`;
  // While dragging, the label reads the snapped landing time.
  const shownTime = drag.preview ? minutesToDisplayTime(drag.preview.startMinutes) : event.startTime;

  return (
    <div
      className={`week-event${event.isCompleted ? ' week-event--done' : ''}${compact ? ' week-event--compact' : ''}${drag.dragging ? ' week-event--dragging' : ''}`}
      style={{ top, height: Math.max(height, 14), background: color.light, borderLeft: `3px solid ${color.solid}`, left: leftOffset, right: GAP, width: colWidth, ...drag.style }}
      data-event-id={event.id}
      {...drag.handlers}
    >
      <button
        className="week-event__main"
        onClick={() => dispatch({ type: 'SELECT_EVENT', payload: event })}
        aria-label={event.title}
      >
        <span className="week-event__title">
          <AnnotationMarker notes={notes} testId="event-annotation-marker" />
          {event.title}{compact && shownTime ? ` · ${shownTime}` : ''}
        </span>
        {!compact && shownTime && <span className="week-event__time">{shownTime}</span>}
      </button>
      <button
        className="week-event__check"
        onClick={e => { e.stopPropagation(); toggleCompletion(event.id); }}
        aria-label={event.isCompleted ? 'Mark incomplete' : 'Mark complete'}
        title={event.isCompleted ? 'Mark incomplete' : 'Mark complete'}
      >
        {event.isCompleted
          ? <CheckCircle2 size={12} strokeWidth={2} />
          : <Circle size={12} strokeWidth={1.5} />
        }
      </button>
    </div>
  );
}

interface DayColumnProps {
  day: Date;
  events: WorkoutEvent[];
  nowTop: number;
}

function DayColumn({ day, events, nowTop }: DayColumnProps) {
  const dateKey = toDateString(day);
  const { columns, colCounts } = layoutDayEvents(events);
  const today = isToday(day);
  // A block dragged over this column: highlighted as the drop target.
  const isDropTarget = useIsDropTarget(dateKey);
  return (
    <div
      className={`week-view__day-col ${today ? 'week-view__day-col--today' : ''}${isDropTarget ? ' week-view__day-col--drop-target' : ''}`}
      style={{ height: HOURS.length * SLOT_HEIGHT }}
      {...{ [DROP_DATE_ATTR]: dateKey }}
    >
      {HOURS.map(h => (
        <div key={h} className="week-view__hour-line" style={{ top: ((h - 5) * SLOT_HEIGHT) }} />
      ))}
      {events.map((e, i) => <EventBlock key={e.id} event={e} colIndex={columns[i]} colCount={colCounts[i]} />)}
      {today && nowTop > 0 && nowTop < HOURS.length * SLOT_HEIGHT && (
        <div className="week-view__now-line" style={{ top: nowTop }}>
          <span className="week-view__now-dot" />
        </div>
      )}
    </div>
  );
}

export default function WeekView({ currentDate }: { currentDate: Date }) {
  const days = useMemo(() => buildWeekDays(currentDate), [currentDate]);
  const { getEventsForDate } = useSchedule();
  const { byDay } = useAnnotations();
  // Only timed events get a block (and so a complete circle) in this grid.
  const hasEvents = useMemo(
    () => days.some(day => getEventsForDate(day).some(e => e.startTime)),
    [days, getEventsForDate],
  );
  useTip('day-complete-circle', hasEvents);
  const [nowMinutes, setNowMinutes] = useState(() => now().getHours() * 60 + now().getMinutes());

  useEffect(() => {
    const id = setInterval(() => setNowMinutes(now().getHours() * 60 + now().getMinutes()), 60000);
    return () => clearInterval(id);
  }, []);

  const nowTop = ((nowMinutes - DAY_START) / 60) * SLOT_HEIGHT;

  return (
    <div className="week-view">
      <div className="week-view__scroll">
        <div className="week-view__inner">
          {/* Header lives inside scroll container so it moves with horizontal scroll */}
          <div className="week-view__header">
            <div className="week-view__time-gutter" />
            {days.map(day => (
              <div key={day.toISOString()} className={`week-view__day-header ${isToday(day) ? 'week-view__day-header--today' : ''}`}>
                {/* A day note is a dot beside the weekday, not a pill: the
                    header is a fixed-height row, and the day view has the pills. */}
                <span className="week-view__dow">
                  {format(day, 'EEE')}
                  <AnnotationMarker notes={byDay(toDateString(day))} testId="day-annotation-marker" />
                </span>
                <span className={`week-view__day-num ${isToday(day) ? 'week-view__day-num--today' : ''}`}>{format(day, 'd')}</span>
              </div>
            ))}
          </div>
          {/* Body — no overflow-y; scroll delegated to .week-view__scroll */}
          <div className="week-view__body">
            <div className="week-view__time-col">
              {HOURS.map(h => (
                <div key={h} className="week-view__hour-label">
                  {format(new Date(2020, 0, 1, h), 'h a')}
                </div>
              ))}
            </div>
            {days.map(day => (
              <DayColumn
                key={day.toISOString()}
                day={day}
                events={getEventsForDate(day).filter(e => e.startTime)}
                nowTop={nowTop}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
