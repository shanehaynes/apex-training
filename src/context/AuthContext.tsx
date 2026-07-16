import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import { ApiError, getJson, patchJson } from '../lib/api';
import { clearCompletedIds } from '../lib/schedule/localCompletion';
import type { AvatarKey, ProfileRow } from '../lib/db/types';
import { registerAgentState } from '../dev/agentBridge';

// Invite and recovery links land with the session in the URL fragment plus a
// `type` marker (`invite` / `recovery`). supabase-js consumes the fragment
// during detectSessionInUrl, so capture it synchronously at module init —
// by the time React renders it may already be gone.
const initialHashParams = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '',
);
const initialLinkType = initialHashParams.get('type');
// Expired/used links arrive with error_description instead of a session.
const initialLinkError = initialHashParams.get('error_description');
const arrivedNeedingPassword = initialLinkType === 'invite' || initialLinkType === 'recovery';

export type AuthStatus = 'offline' | 'loading' | 'signedOut' | 'needsPassword' | 'signedIn';

/** What the browser is allowed to know about the user's Anthropic key. */
export interface AnthropicKeyStatus {
  hasKey: boolean;
  last4: string | null;
}

interface KeyStatusPayload {
  hasAnthropicKey?: boolean;
  anthropicKeyLast4?: string | null;
}

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  profile: ProfileRow | null;
  /** null = not yet loaded/unknown (don't block the coach UI on it). */
  anthropicKey: AnthropicKeyStatus | null;
  /** Error carried by an expired/used invite or recovery link, for LoginView. */
  linkError: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<string | null>;
  setNewPassword: (password: string) => Promise<string | null>;
  updateProfile: (fields: { displayName?: string; avatarKey?: AvatarKey }) => Promise<boolean>;
  refreshProfile: () => Promise<void>;
  /** Save/replace the user's Anthropic API key. Returns an error message, or null on success. */
  saveAnthropicKey: (key: string) => Promise<string | null>;
  removeAnthropicKey: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(supabase ? 'loading' : 'offline');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [anthropicKey, setAnthropicKey] = useState<AnthropicKeyStatus | null>(null);

  const applyKeyStatus = useCallback((payload: KeyStatusPayload | undefined) => {
    if (payload?.hasAnthropicKey === undefined) return;
    setAnthropicKey({ hasKey: payload.hasAnthropicKey, last4: payload.anthropicKeyLast4 ?? null });
  }, []);

  const loadKeyStatus = useCallback(async () => {
    try {
      applyKeyStatus(await getJson<KeyStatusPayload>('/api/profile', 'Loading key status'));
    } catch {
      // Unknown stays null — the coach UI treats that as "don't block".
    }
  }, [applyKeyStatus]);

  const loadProfile = useCallback(async (userId: string) => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      console.warn('[apex] Profile load failed:', error.message);
      return;
    }
    if (data) setProfile(data as ProfileRow);
  }, []);

  useEffect(() => {
    const sb = supabase;
    if (!sb) return;

    sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) {
        setStatus(arrivedNeedingPassword ? 'needsPassword' : 'signedIn');
        loadProfile(data.session.user.id);
        loadKeyStatus();
      } else {
        setStatus(prev => (prev === 'loading' ? 'signedOut' : prev));
      }
    });

    const { data: sub } = sb.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'PASSWORD_RECOVERY') {
        setStatus('needsPassword');
      } else if (event === 'SIGNED_IN' && next) {
        // An invite/recovery link fires SIGNED_IN too — keep the set-password
        // screen up until the user actually submits one.
        setStatus(prev => (prev === 'needsPassword' ? prev : 'signedIn'));
        loadProfile(next.user.id);
        loadKeyStatus();
      } else if (event === 'SIGNED_OUT') {
        setProfile(null);
        setAnthropicKey(null);
        setStatus('signedOut');
      }
    });
    return () => { sub.subscription.unsubscribe(); };
  }, [loadProfile, loadKeyStatus]);

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('auth', () => ({
      status,
      userId: session?.user.id ?? null,
      email: session?.user.email ?? null,
      displayName: profile?.display_name ?? null,
      hasAnthropicKey: anthropicKey?.hasKey ?? null,
      anthropicKeyLast4: anthropicKey?.last4 ?? null,
    }));
  }, [status, session, profile, anthropicKey]);

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    if (!supabase) return 'Offline mode — no auth configured';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    clearCompletedIds();
    await supabase.auth.signOut();
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<string | null> => {
    if (!supabase) return 'Offline mode — no auth configured';
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    return error ? error.message : null;
  }, []);

  const setNewPassword = useCallback(async (password: string): Promise<string | null> => {
    if (!supabase) return 'Offline mode — no auth configured';
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) return error.message;
    setStatus('signedIn');
    if (data.user) loadProfile(data.user.id);
    return null;
  }, [loadProfile]);

  const updateProfile = useCallback(async (fields: {
    displayName?: string; avatarKey?: AvatarKey; coachGoal?: string; coachContext?: string;
  }): Promise<boolean> => {
    if (!supabase) return false;
    try {
      await patchJson('/api/profile', {
        ...(fields.displayName !== undefined ? { display_name: fields.displayName } : {}),
        ...(fields.avatarKey !== undefined ? { avatar_key: fields.avatarKey } : {}),
        ...(fields.coachGoal !== undefined ? { coach_goal: fields.coachGoal } : {}),
        ...(fields.coachContext !== undefined ? { coach_context: fields.coachContext } : {}),
      }, 'Updating profile');
      // Optimistic local apply; the row is ours alone, no reconciliation needed.
      setProfile(prev => prev && {
        ...prev,
        ...(fields.displayName !== undefined ? { display_name: fields.displayName } : {}),
        ...(fields.avatarKey !== undefined ? { avatar_key: fields.avatarKey } : {}),
        ...(fields.coachGoal !== undefined ? { coach_goal: fields.coachGoal } : {}),
        ...(fields.coachContext !== undefined ? { coach_context: fields.coachContext } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session) await loadProfile(session.user.id);
  }, [session, loadProfile]);

  const saveAnthropicKey = useCallback(async (key: string): Promise<string | null> => {
    if (!supabase) return 'Offline mode — no auth configured';
    try {
      applyKeyStatus(await patchJson<KeyStatusPayload>(
        '/api/profile', { anthropic_api_key: key }, 'Saving API key',
      ));
      return null;
    } catch (err) {
      // Server messages are actionable and never contain the key.
      return err instanceof ApiError && err.message ? err.message : 'Failed to save the API key';
    }
  }, [applyKeyStatus]);

  const removeAnthropicKey = useCallback(async (): Promise<boolean> => {
    if (!supabase) return false;
    try {
      await patchJson('/api/profile', { anthropic_api_key: null }, 'Removing API key');
      setAnthropicKey({ hasKey: false, last4: null });
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      status,
      session,
      profile,
      anthropicKey,
      linkError: initialLinkError,
      signIn,
      signOut,
      resetPassword,
      setNewPassword,
      updateProfile,
      refreshProfile,
      saveAnthropicKey,
      removeAnthropicKey,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
