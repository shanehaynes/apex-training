import { AuthProvider, useAuth } from './context/AuthContext';
import { CalendarProvider } from './context/CalendarContext';
import { ScheduleProvider } from './context/ScheduleContext';
import AppShell from './components/layout/AppShell';
import LoginView from './components/auth/LoginView';
import SetPasswordView from './components/auth/SetPasswordView';
import './styles/global.css';
import './styles/app.css';

function AuthGate() {
  const { status, session } = useAuth();

  // Offline mode (no Supabase env) has no auth to gate — render the app on
  // the bundled seed schedule, exactly as before multi-user.
  if (status === 'loading') {
    return <div className="auth-screen" aria-busy="true" />;
  }
  if (status === 'signedOut') return <LoginView />;
  if (status === 'needsPassword') return <SetPasswordView />;

  // Keyed by user id: switching accounts remounts the data layer (fresh
  // state, and the realtime channel subscribes only after a session exists,
  // so RLS-authorized delivery never silently drops events).
  return (
    <ScheduleProvider key={session?.user.id ?? 'offline'}>
      <CalendarProvider>
        <AppShell />
      </CalendarProvider>
    </ScheduleProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
