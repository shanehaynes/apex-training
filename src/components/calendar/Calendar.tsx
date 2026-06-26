import { useRef } from 'react';
import { useCalendar } from '../../context/CalendarContext';
import MonthView from './MonthView';
import WeekView from './WeekView';
import DayView from './DayView';

export default function Calendar() {
  const { state } = useCalendar();
  const prevDate = useRef(state.currentDate);
  const direction = state.currentDate >= prevDate.current ? 1 : -1;
  prevDate.current = state.currentDate;

  return (
    <div className="calendar">
      {state.selectedView === 'month' ? (
        <MonthView currentDate={state.currentDate} direction={direction} />
      ) : state.selectedView === 'week' ? (
        <WeekView currentDate={state.currentDate} />
      ) : (
        <DayView currentDate={state.currentDate} />
      )}
    </div>
  );
}
