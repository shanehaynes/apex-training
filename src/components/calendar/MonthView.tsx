import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { buildMonthGrid } from '../../utils/dateHelpers';
import DayCell from './DayCell';
import { useSchedule } from '../../context/ScheduleContext';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  currentDate: Date;
  direction: number;
}

export default function MonthView({ currentDate, direction }: Props) {
  const { getEventsForDate } = useSchedule();
  const weeks = useMemo(() => buildMonthGrid(currentDate), [currentDate]);

  // DOW labels are first 7 items in the unified grid; date rows fill remaining space equally
  const gridRows = `auto repeat(${weeks.length}, 1fr)`;

  return (
    <div className="month-view">
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={currentDate.toISOString()}
          className="month-view__grid"
          style={{ gridTemplateRows: gridRows }}
          custom={direction}
          initial={{ opacity: 0, x: direction * 40 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: direction * -40 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          {DOW.map(d => <span key={d} className="month-view__dow">{d}</span>)}
          {weeks.map((week, wi) =>
            week.map((date, di) => (
              <DayCell
                key={`${wi}-${di}`}
                date={date}
                currentMonth={currentDate}
                events={getEventsForDate(date)}
              />
            ))
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
