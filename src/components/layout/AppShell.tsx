import { useState, useEffect } from 'react';
import TopNav from './TopNav';
import Calendar from '../calendar/Calendar';
import ChatSidebar from '../sidebar/ChatSidebar';
import WorkoutModal from '../modal/WorkoutModal';
import TrackerView from '../tracker/TrackerView';
import MobileBottomNav from './MobileBottomNav';
import Toasts from './Toasts';
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
          <ChatSidebar />
        </aside>
      </div>
      {isMobile && (
        <MobileBottomNav activeTab={mobileTab} onChange={setMobileTab} />
      )}
      {state.selectedEvent && <WorkoutModal />}
      {state.trackingSession && <TrackerView />}
      <Toasts />
    </div>
  );
}
