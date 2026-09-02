import { useState } from 'react';
import { CalendarDays, BarChart2, MessageSquare, Dumbbell, Plus, UtensilsCrossed } from 'lucide-react';
import { useCalendar } from '../../context/calendar';
import { toDateString } from '../../utils/dateHelpers';

// 'coach' was labeled 'analytics' before phase 35 shipped a real analytics
// view — the tab always swapped in the chat sidebar (the CSS keys off
// data-mobile-tab="coach"). Analytics itself is not a tab: it opens the
// full-screen dashboard overlay, so the button dispatches OPEN_ANALYTICS
// and shows active while that overlay is up.
export type MobileTab = 'calendar' | 'coach';

interface Props {
  activeTab: MobileTab;
  onChange: (tab: MobileTab) => void;
}

export default function MobileBottomNav({ activeTab, onChange }: Props) {
  const { state, dispatch } = useCalendar();
  const [addOpen, setAddOpen] = useState(false);

  // Mobile is day view, so the visible day is where an add lands.
  const openBuilder = () => {
    setAddOpen(false);
    dispatch({ type: 'OPEN_COMPOSER', payload: toDateString(state.currentDate) });
  };
  const openMealComposer = () => {
    setAddOpen(false);
    dispatch({ type: 'OPEN_MEAL_COMPOSER', payload: toDateString(state.currentDate) });
  };

  return (
    <nav className="mobile-nav" aria-label="Main navigation">
      <button
        className={`mobile-nav__tab${activeTab === 'calendar' ? ' mobile-nav__tab--active' : ''}`}
        onClick={() => onChange('calendar')}
        aria-selected={activeTab === 'calendar'}
      >
        <CalendarDays size={22} strokeWidth={1.5} />
        <span>Calendar</span>
      </button>
      {/* Its own class, not a third tab: it navigates nowhere and the tab
          styling (and specs addressing tabs by index) shouldn't absorb it. */}
      <div className="mobile-nav__add-wrap">
        {addOpen && (
          <div className="mobile-nav__add-menu" role="menu">
            <button role="menuitem" onClick={openBuilder}>
              <Dumbbell size={16} strokeWidth={1.5} /> Workout
            </button>
            <button role="menuitem" onClick={openMealComposer}>
              <UtensilsCrossed size={16} strokeWidth={1.5} /> Meal
            </button>
          </div>
        )}
        <button
          className={`mobile-nav__add${addOpen ? ' mobile-nav__add--open' : ''}`}
          onClick={() => setAddOpen(v => !v)}
          aria-label="Add"
          aria-expanded={addOpen}
        >
          <Plus size={24} strokeWidth={2} />
        </button>
      </div>
      <button
        className={`mobile-nav__tab${activeTab === 'coach' ? ' mobile-nav__tab--active' : ''}`}
        onClick={() => onChange('coach')}
        aria-selected={activeTab === 'coach'}
      >
        <MessageSquare size={22} strokeWidth={1.5} />
        <span>Coach</span>
      </button>
      <button
        className={`mobile-nav__tab${state.analyticsOpen ? ' mobile-nav__tab--active' : ''}`}
        onClick={() => dispatch({ type: 'OPEN_ANALYTICS' })}
        aria-selected={state.analyticsOpen}
        data-testid="mobile-nav-analytics"
      >
        <BarChart2 size={22} strokeWidth={1.5} />
        <span>Analytics</span>
      </button>
    </nav>
  );
}
