import { useState, useEffect, useRef } from 'react';
import TopNav from './TopNav';
import Calendar from '../calendar/Calendar';
import ChatSidebar from '../sidebar/ChatSidebar';
import WorkoutModal from '../modal/WorkoutModal';
import DayModal from '../modal/DayModal';
import AddEventView from '../composer/AddEventView';
import AddMealView from '../composer/AddMealView';
import TrackerView from '../tracker/TrackerView';
import LibraryView from '../library/LibraryView';
import BlocksView from '../blocks/BlocksView';
import ProfileView from '../profile/ProfileView';
import TemplateOfferBanner from '../profile/TemplateOfferBanner';
import MobileBottomNav from './MobileBottomNav';
import Toasts from './Toasts';
import { useCalendar } from '../../context/CalendarContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import type { MobileTab } from './MobileBottomNav';

export default function AppShell() {
  const { state, dispatch } = useCalendar();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [mobileTab, setMobileTab] = useState<MobileTab>('calendar');

  // Mobile is day-view only. Crossing the breakpoint remembers the desktop
  // view so widening the window restores Week instead of resetting to Month.
  const desktopViewRef = useRef<'month' | 'week'>('month');
  useEffect(() => {
    if (isMobile && state.selectedView !== 'day') {
      desktopViewRef.current = state.selectedView === 'week' ? 'week' : 'month';
      dispatch({ type: 'SET_VIEW', payload: 'day' });
    } else if (!isMobile && state.selectedView === 'day') {
      dispatch({ type: 'SET_VIEW', payload: desktopViewRef.current });
    }
  }, [isMobile, state.selectedView, dispatch]);

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
      {state.selectedDay && <DayModal />}
      {state.composerDate && <AddEventView />}
      {state.mealComposerDate && <AddMealView />}
      {state.trackingSession && <TrackerView />}
      {state.libraryOpen && <LibraryView />}
      {state.blocksOpen && <BlocksView />}
      {state.profileOpen && <ProfileView />}
      <TemplateOfferBanner />
      <Toasts />
    </div>
  );
}
