import { useState } from 'react';
import { useCalendar } from '../../context/calendar';
import MonthView from './MonthView';
import WeekView from './WeekView';
import DayView from './DayView';

export default function Calendar() {
  const { state } = useCalendar();
  // Derived state, not a render-phase ref write: under StrictMode's double
  // render a ref would already hold the new date on the second pass and the
  // slide direction would come out wrong.
  const [slide, setSlide] = useState({ date: state.currentDate, direction: 1 });
  if (state.currentDate !== slide.date) {
    setSlide({ date: state.currentDate, direction: state.currentDate >= slide.date ? 1 : -1 });
  }
  const direction = slide.direction;

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
