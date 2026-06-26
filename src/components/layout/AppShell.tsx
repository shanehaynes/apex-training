import { useState, useEffect } from 'react';
import TopNav from './TopNav';
import Calendar from '../calendar/Calendar';
import Sidebar from '../sidebar/Sidebar';
import WorkoutModal from '../modal/WorkoutModal';
import MobileBottomNav from './MobileBottomNav';
import { useCalendar } from '../../context/CalendarContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import type { MobileTab } from './MobileBottomNav';

export default function AppShell() {
  const { state, dispatch } = useCalendar();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mobileTab, setMobileTab] = useState<MobileTab>('calendar');

  useEffect(() => {
    if (isMobile && state.selectedView !== 'day') {
      dispatch({ type: 'SET_VIEW', payload: 'day' });
    } else if (!isMobile && state.selectedView === 'day') {
      dispatch({ type: 'SET_VIEW', payload: 'month' });
    }
  }, [isMobile]);

  return (
    <div className="app-shell">
      <TopNav />
      <div className="app-body" data-mobile-tab={isMobile ? mobileTab : undefined}>
        <main className="app-main">
          <Calendar />
        </main>
        <aside className="app-sidebar">
          <Sidebar />
        </aside>
      </div>
      {isMobile && (
        <MobileBottomNav activeTab={mobileTab} onChange={setMobileTab} />
      )}
      {state.selectedEvent && <WorkoutModal />}
    </div>
  );
}
