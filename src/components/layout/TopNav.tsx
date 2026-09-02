import { BarChart2, ChevronLeft, ChevronRight, Dumbbell, Plus, Target } from 'lucide-react';
import { useCalendar } from '../../context/calendar';
import { useAuth } from '../../context/auth';
import ProviderSyncControls from '../sync/ProviderSyncControls';
import { avatarSrc, AVATARS } from '../../lib/profile/avatars';
import { formatMonthYear, formatWeekRange, formatDay, isCurrentPeriod, toDateString } from '../../utils/dateHelpers';
import type { CalendarView } from '../../types/workout';

export default function TopNav() {
  const { state, dispatch } = useCalendar();
  const { status, profile } = useAuth();
  const { currentDate, selectedView } = state;

  const periodLabel = selectedView === 'month'
    ? formatMonthYear(currentDate)
    : selectedView === 'week'
    ? formatWeekRange(currentDate)
    : formatDay(currentDate);

  return (
    <nav className="top-nav">
      <div className="top-nav__brand">
        {status === 'signedIn' && (
          <button
            className="top-nav__avatar"
            onClick={() => dispatch({ type: 'OPEN_PROFILE' })}
            title={profile?.display_name || 'Profile'}
            aria-label="Open profile"
          >
            <img
              src={avatarSrc(profile?.avatar_key)}
              alt={profile ? AVATARS[profile.avatar_key]?.label ?? 'Avatar' : 'Avatar'}
            />
          </button>
        )}
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
        <ProviderSyncControls />
        <button
          className="btn-library btn-library--add"
          data-testid="nav-add-workout"
          onClick={() => dispatch({ type: 'OPEN_COMPOSER', payload: toDateString(currentDate) })}
          title="Add workout"
        >
          <Plus size={14} strokeWidth={2} />
          <span className="btn-library__label">Add</span>
        </button>
        <button
          className="btn-library"
          data-testid="nav-blocks"
          onClick={() => dispatch({ type: 'OPEN_BLOCKS' })}
          title="Training blocks"
        >
          <Target size={14} strokeWidth={1.5} />
          <span className="btn-library__label">Blocks</span>
        </button>
        <button
          className="btn-library"
          onClick={() => dispatch({ type: 'OPEN_LIBRARY' })}
          title="Exercise library"
        >
          <Dumbbell size={14} strokeWidth={1.5} />
          <span className="btn-library__label">Library</span>
        </button>
        <button
          className="btn-library"
          data-testid="nav-analytics"
          onClick={() => dispatch({ type: 'OPEN_ANALYTICS' })}
          title="Analytics"
        >
          <BarChart2 size={14} strokeWidth={1.5} />
          <span className="btn-library__label">Analytics</span>
        </button>
        <button
          className="btn-today"
          onClick={() => dispatch({ type: 'GO_TO_TODAY' })}
          disabled={isCurrentPeriod(currentDate, selectedView)}
        >
          Today
        </button>
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
