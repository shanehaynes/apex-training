import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCalendar } from '../../context/CalendarContext';
import { formatMonthYear, formatWeekRange, formatDay } from '../../utils/dateHelpers';
import type { CalendarView } from '../../types/workout';

export default function TopNav() {
  const { state, dispatch } = useCalendar();
  const { currentDate, selectedView } = state;

  const periodLabel = selectedView === 'month'
    ? formatMonthYear(currentDate)
    : selectedView === 'week'
    ? formatWeekRange(currentDate)
    : formatDay(currentDate);

  return (
    <nav className="top-nav">
      <div className="top-nav__brand">
        <span className="top-nav__logo">APEX</span>
        <span className="top-nav__sub">Training</span>
      </div>

      <div className="top-nav__controls">
        <button className="nav-arrow" onClick={() => dispatch({ type: 'PREV_PERIOD' })} aria-label="Previous">
          <ChevronLeft size={18} strokeWidth={1.5} />
        </button>
        <span className="nav-period">{periodLabel}</span>
        <button className="nav-arrow" onClick={() => dispatch({ type: 'NEXT_PERIOD' })} aria-label="Next">
          <ChevronRight size={18} strokeWidth={1.5} />
        </button>
      </div>

      <div className="top-nav__right">
        <button className="btn-today" onClick={() => dispatch({ type: 'GO_TO_TODAY' })}>Today</button>
        <div className="view-toggle">
          {(['month', 'week'] as CalendarView[]).map(view => (
            <button
              key={view}
              className={`view-toggle__btn ${selectedView === view ? 'view-toggle__btn--active' : ''}`}
              onClick={() => dispatch({ type: 'SET_VIEW', payload: view })}
            >
              {view.charAt(0).toUpperCase() + view.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
