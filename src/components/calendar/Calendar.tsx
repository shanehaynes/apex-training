import { useEffect, useMemo, useState } from 'react';
import { useCalendar } from '../../context/calendar';
import { useAuth } from '../../context/auth';
import { useTip } from '../../hooks/useTip';
import { clearTemplateCopiedHere, templateCopiedHere } from '../../hooks/useTemplateCopy';
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

  // The template-copied tip, on the first calendar mount after this device
  // copied the starter plan — in practice the next load, since the calendar
  // stays mounted under the welcome flow that ran the copy. Read per mount
  // (and per user), not per render, so the copy's own "Added N recurring
  // workouts" toast is not chased by a card on the same screen.
  const { session, profile, tipsSeen } = useAuth();
  const userId = session?.user.id ?? null;
  const copiedHere = useMemo(() => templateCopiedHere(userId), [userId]);
  useTip('template-copied', copiedHere && !!profile?.template_copied_at);
  const tipSeen = tipsSeen.has('template-copied');
  useEffect(() => {
    if (copiedHere && tipSeen) clearTemplateCopiedHere(userId);
  }, [copiedHere, tipSeen, userId]);

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
