import { CalendarProvider } from './context/CalendarContext';
import { ScheduleProvider } from './context/ScheduleContext';
import AppShell from './components/layout/AppShell';
import './styles/global.css';
import './styles/app.css';

export default function App() {
  return (
    <ScheduleProvider>
      <CalendarProvider>
        <AppShell />
      </CalendarProvider>
    </ScheduleProvider>
  );
}
