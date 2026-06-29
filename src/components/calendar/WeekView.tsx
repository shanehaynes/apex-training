import { useMemo, useEffect, useState } from 'react';
import { format, isToday } from 'date-fns';
import { CheckCircle2, Circle } from 'lucide-react';
import { buildWeekDays } from '../../utils/dateHelpers';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useSchedule } from '../../context/ScheduleContext';
import { useCalendar } from '../../context/CalendarContext';
import type { WorkoutEvent } from '../../types/workout';

const HOURS = Array.from({ length: 18 }, (_, i) => i + 5); // 5 AM – 10 PM

function timeToMinutes(t: string): number {
  const [time, period] = t.split(' ');
  const [h, m] = time.split(':').map(Number);
  const hours = period === 'PM' && h !== 12 ? h + 12 : period === 'AM' && h === 12 ? 0 : h;
  return hours * 60 + (m || 0);
}

const SLOT_HEIGHT = 56; // px per hour
const DAY_START = 5 * 60; // 5 AM in minutes

interface EventBlockProps {
  event: WorkoutEvent;
  colIndex: number;
  colCount: number;
}

function EventBlock({ event, colIndex, colCount }: EventBlockProps) {
  const { dispatch } = useCalendar();
  const { toggleCompletion } = useSchedule();
  const color = getWorkoutColor(event.type);
  const top = event.startTime ? ((timeToMinutes(event.startTime) - DAY_START) / 60) * SLOT_HEIGHT : 0;
  const height = Math.max((event.estimatedDuration / 60) * SLOT_HEIGHT, 44);

  const GAP = 4;
  const colWidth = `calc((100% - ${GAP * (colCount + 1)}px) / ${colCount})`;
  const leftOffset = `calc(${GAP}px + (${colWidth} + ${GAP}px) * ${colIndex})`;

  return (
    <div
      className={`week-event${event.isCompleted ? ' week-event--done' : ''}`}
      style={{ top, height, background: color.light, borderLeft: `3px solid ${color.solid}`, left: leftOffset, right: GAP, width: colWidth }}
    >
      <button
        className="week-event__main"
        onClick={() => dispatch({ type: 'SELECT_EVENT', payload: event })}
        aria-label={event.title}
      >
        <span className="week-event__title">{event.title}</span>
        {event.startTime && <span className="week-event__time">{event.startTime}</span>}
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

export default function WeekView({ currentDate }: { currentDate: Date }) {
  const days = useMemo(() => buildWeekDays(currentDate), [currentDate]);
  const { getEventsForDate } = useSchedule();
  const [nowMinutes, setNowMinutes] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());

  useEffect(() => {
    const id = setInterval(() => setNowMinutes(new Date().getHours() * 60 + new Date().getMinutes()), 60000);
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
                <span className="week-view__dow">{format(day, 'EEE')}</span>
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
            {days.map((day) => {
              const events = getEventsForDate(day).filter(e => e.startTime);
              // Assign columns to overlapping events
              const columns: number[] = [];
              const colCounts: number[] = [];
              events.forEach((e, i) => {
                const startA = timeToMinutes(e.startTime!);
                const endA = startA + e.estimatedDuration;
                // Find which columns are taken by events that overlap with e
                const taken = new Set<number>();
                events.forEach((other, j) => {
                  if (j >= i) return;
                  const startB = timeToMinutes(other.startTime!);
                  const endB = startB + other.estimatedDuration;
                  if (startA < endB && endA > startB) taken.add(columns[j]);
                });
                let col = 0;
                while (taken.has(col)) col++;
                columns[i] = col;
              });
              // Compute colCount per event: max column index among all events that overlap with it, +1
              events.forEach((e, i) => {
                const startA = timeToMinutes(e.startTime!);
                const endA = startA + e.estimatedDuration;
                let maxCol = columns[i];
                events.forEach((other, j) => {
                  if (i === j) return;
                  const startB = timeToMinutes(other.startTime!);
                  const endB = startB + other.estimatedDuration;
                  if (startA < endB && endA > startB) maxCol = Math.max(maxCol, columns[j]);
                });
                colCounts[i] = maxCol + 1;
              });
              return (
                <div key={day.toISOString()} className={`week-view__day-col ${isToday(day) ? 'week-view__day-col--today' : ''}`}
                  style={{ height: HOURS.length * SLOT_HEIGHT }}>
                  {HOURS.map(h => (
                    <div key={h} className="week-view__hour-line" style={{ top: ((h - 5) * SLOT_HEIGHT) }} />
                  ))}
                  {events.map((e, i) => <EventBlock key={e.id} event={e} colIndex={columns[i]} colCount={colCounts[i]} />)}
                  {isToday(day) && nowTop > 0 && nowTop < HOURS.length * SLOT_HEIGHT && (
                    <div className="week-view__now-line" style={{ top: nowTop }}>
                      <span className="week-view__now-dot" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
