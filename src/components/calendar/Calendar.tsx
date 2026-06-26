import { useRef } from 'react';
import { useCalendar } from '../../context/CalendarContext';
import MonthView from './MonthView';
import WeekView from './WeekView';

export default function Calendar() {
  const { state } = useCalendar();
  const prevDate = useRef(state.currentDate);
  const direction = state.currentDate >= prevDate.current ? 1 : -1;
  prevDate.current = state.currentDate;

  return (
    <div className="calendar">
      {state.selectedView === 'month'
        ? <MonthView currentDate={state.currentDate} direction={direction} />
        : <WeekView currentDate={state.currentDate} />
      }
    </div>
  );
}
