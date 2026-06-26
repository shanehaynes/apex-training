import { useState, useMemo } from 'react';
import { useSchedule } from '../../context/ScheduleContext';
import { getEventsByDateRange, countByType, getTotalDuration, getMostActiveDay, getUniqueTypes, getWeeklyVolume } from '../../utils/analytics';
import { getWorkoutColor } from '../../utils/workoutColors';
import { useCalendar } from '../../context/CalendarContext';
import { format, parseISO, isToday, isTomorrow, endOfWeek } from 'date-fns';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { DateRange, WorkoutType } from '../../types/workout';

const RANGE_OPTIONS: { label: string; value: DateRange }[] = [
  { label: 'This Week', value: 'week' },
  { label: 'This Month', value: 'month' },
  { label: 'All Time', value: 'all' },
];

const TYPE_ORDER: WorkoutType[] = ['weights', 'climbing', 'morning-routine', 'stretching', 'cardio', 'yoga', 'rest'];

function StatCard({ label, value, mono = false }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="stat-card">
      <span className="stat-card__label">{label}</span>
      <span className={`stat-card__value ${mono ? 'stat-card__value--mono' : ''}`}>{value}</span>
    </div>
  );
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip__week">{payload[0].payload.weekLabel}</p>
      <p className="chart-tooltip__count">{payload[0].value} sessions</p>
    </div>
  );
}

export default function Sidebar() {
  const [range, setRange] = useState<DateRange>('week');
  const { events } = useSchedule();
  const { dispatch } = useCalendar();

  const filtered = useMemo(() => getEventsByDateRange(events, range), [events, range]);
  const typeCounts = useMemo(() => countByType(filtered), [filtered]);
  const totalMinutes = useMemo(() => getTotalDuration(filtered), [filtered]);
  const peakDay = useMemo(() => getMostActiveDay(filtered), [filtered]);
  const uniqueTypes = useMemo(() => getUniqueTypes(filtered), [filtered]);
  const weeklyVolume = useMemo(() => getWeeklyVolume(events, 6), [events]);

  const thisWeekEnd = endOfWeek(new Date(), { weekStartsOn: 1 });
  const upcomingEvents = useMemo(() =>
    events
      .filter(e => {
        const d = parseISO(e.date);
        return d >= new Date(new Date().setHours(0,0,0,0)) && d <= thisWeekEnd;
      })
      .sort((a, b) => {
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return (a.startTime ?? '').localeCompare(b.startTime ?? '');
      }),
  [events]);

  const groupedUpcoming = useMemo(() => {
    const groups: Record<string, typeof upcomingEvents> = {};
    for (const e of upcomingEvents) {
      const d = parseISO(e.date);
      const key = isToday(d) ? 'TODAY' : isTomorrow(d) ? 'TOMORROW' : format(d, 'EEEE').toUpperCase();
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }
    return groups;
  }, [upcomingEvents]);

  return (
    <div className="sidebar">
      <div className="sidebar__section">
        <h2 className="sidebar__heading">Analytics</h2>
        <div className="range-toggle">
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`range-toggle__btn ${range === opt.value ? 'range-toggle__btn--active' : ''}`}
              onClick={() => setRange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar__section">
        <div className="stat-grid">
          <StatCard label="Sessions" value={filtered.length} mono />
          <StatCard label="Hours Trained" value={(totalMinutes / 60).toFixed(1)} mono />
          <StatCard label="Peak Day" value={peakDay} />
          <StatCard label="Types Active" value={`${uniqueTypes} of 7`} />
        </div>
      </div>

      <div className="sidebar__section">
        <h3 className="sidebar__subheading">By Type</h3>
        <div className="type-bars">
          {TYPE_ORDER.map(type => {
            const count = typeCounts[type];
            if (count === 0 && range !== 'all') return null;
            const color = getWorkoutColor(type);
            const maxForType = Math.max(...TYPE_ORDER.map(t => typeCounts[t]), 1);
            const pct = (count / maxForType) * 100;
            return (
              <div key={type} className="type-bar-row">
                <span className="type-bar-row__label">
                  <span className="type-bar-row__dot" style={{ background: color.solid }} />
                  {color.label}
                </span>
                <div className="type-bar-row__track">
                  <div
                    className="type-bar-row__fill"
                    style={{ width: `${pct}%`, background: color.solid }}
                  />
                </div>
                <span className="type-bar-row__count">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="sidebar__section">
        <h3 className="sidebar__subheading">Weekly Volume</h3>
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={weeklyVolume} barSize={16}>
            <XAxis dataKey="weekLabel" tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Bar dataKey="count" radius={[3, 3, 0, 0]}>
              {weeklyVolume.map((entry, i) => (
                <Cell key={i} fill={entry.count > 0 ? '#3b82f6' : '#1f2d45'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="sidebar__section sidebar__section--upcoming">
        <h3 className="sidebar__subheading">This Week</h3>
        {Object.entries(groupedUpcoming).length === 0 ? (
          <p className="sidebar__empty">No upcoming workouts this week.</p>
        ) : (
          Object.entries(groupedUpcoming).map(([day, dayEvents]) => (
            <div key={day} className="upcoming-group">
              <span className={`upcoming-group__day ${day === 'TODAY' ? 'upcoming-group__day--today' : ''}`}>{day}</span>
              {dayEvents.map(e => {
                const color = getWorkoutColor(e.type);
                return (
                  <button
                    key={e.id}
                    className="upcoming-item"
                    onClick={() => dispatch({ type: 'SELECT_EVENT', payload: e })}
                  >
                    <span className="upcoming-item__dot" style={{ background: color.solid }} />
                    <span className="upcoming-item__time">{e.startTime ?? '—'}</span>
                    <span className="upcoming-item__title">{e.title}</span>
                    <span className="upcoming-item__dur">{e.estimatedDuration}m</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
