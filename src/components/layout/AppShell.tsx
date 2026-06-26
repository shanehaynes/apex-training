import TopNav from './TopNav';
import Calendar from '../calendar/Calendar';
import Sidebar from '../sidebar/Sidebar';
import WorkoutModal from '../modal/WorkoutModal';
import { useCalendar } from '../../context/CalendarContext';

export default function AppShell() {
  const { state } = useCalendar();

  return (
    <div className="app-shell">
      <TopNav />
      <div className="app-body">
        <main className="app-main">
          <Calendar />
        </main>
        <aside className="app-sidebar">
          <Sidebar />
        </aside>
      </div>
      {state.selectedEvent && <WorkoutModal />}
    </div>
  );
}
