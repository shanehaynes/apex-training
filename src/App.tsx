import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/auth';
import ErrorBoundary from './components/ErrorBoundary';
import { CalendarProvider } from './context/CalendarContext';
import { MealsProvider } from './context/MealsContext';
import { ScheduleProvider } from './context/ScheduleContext';
import { BlocksProvider } from './context/BlocksContext';
import AppShell from './components/layout/AppShell';
import LoginView from './components/auth/LoginView';
import SetPasswordView from './components/auth/SetPasswordView';
import ConnectApproval from './components/auth/ConnectApproval';
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

  // OAuth consent hand-off (see handlers/oauthAuthorize.ts): signed-in users
  // landing on /connect get the approval card instead of the calendar. After
  // sign-in the pathname persists, so the login → consent flow just works.
  if (window.location.pathname === '/connect') return <ConnectApproval />;

  // Keyed by user id: switching accounts remounts the data layer (fresh
  // state, and the realtime channel subscribes only after a session exists,
  // so RLS-authorized delivery never silently drops events).
  return (
    <ScheduleProvider key={session?.user.id ?? 'offline'}>
      <BlocksProvider>
        <MealsProvider>
          <CalendarProvider>
            <AppShell />
          </CalendarProvider>
        </MealsProvider>
      </BlocksProvider>
    </ScheduleProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ErrorBoundary>
  );
}
