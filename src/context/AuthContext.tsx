import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import { acceptTerms as postAcceptance, ApiError, getJson, patchJson } from '../lib/api';
import type { AcceptanceStatus } from '../lib/api';
import { clearCompletedIds } from '../lib/schedule/localCompletion';
import { publicOrigin } from '../lib/origin';
import { parseAuthLinkError } from '../lib/auth/linkError';
import type { AvatarKey, ProfileRow } from '../lib/db/types';
import { registerAgentState } from '../dev/agentBridge';
import {
  AuthContext, type AnthropicKeyStatus, type AuthContextValue, type AuthStatus, type SignUpResult,
  type TermsStatus,
} from './auth';

// Invite and recovery links land with the session in the URL fragment plus a
// `type` marker (`invite` / `recovery`). supabase-js consumes the fragment
// during detectSessionInUrl, so capture it synchronously at module init —
// by the time React renders it may already be gone.
const initialHash = typeof window !== 'undefined' ? window.location.hash : '';
const initialSearch = typeof window !== 'undefined' ? window.location.search : '';
const initialLinkType = new URLSearchParams(initialHash.replace(/^#/, '')).get('type');
// A refused link brings an error instead of a session — see lib/auth/linkError.
const initialLinkError = parseAuthLinkError(initialHash, initialSearch);
const arrivedNeedingPassword = initialLinkType === 'invite' || initialLinkType === 'recovery';

interface KeyStatusPayload {
  hasAnthropicKey?: boolean;
  anthropicKeyLast4?: string | null;
  termsAccepted?: AcceptanceStatus | null;
  termsCurrent?: boolean;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(supabase ? 'loading' : 'offline');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [anthropicKey, setAnthropicKey] = useState<AnthropicKeyStatus | null>(null);
  const [termsStatus, setTermsStatus] = useState<TermsStatus | null>(null);

  const applyKeyStatus = useCallback((payload: KeyStatusPayload | undefined) => {
    if (payload?.hasAnthropicKey === undefined) return;
    setAnthropicKey({ hasKey: payload.hasAnthropicKey, last4: payload.anthropicKeyLast4 ?? null });
  }, []);

  // GET /api/profile is exempt from the server's terms gate precisely so it
  // can answer this: it is the one call a blocked user can still make, and
  // therefore the only way the client learns the modal is due.
  const loadKeyStatus = useCallback(async () => {
    try {
      const payload = await getJson<KeyStatusPayload>('/api/profile', 'Loading key status');
      applyKeyStatus(payload);
      if (payload?.termsCurrent !== undefined) {
        setTermsStatus({ accepted: payload.termsAccepted ?? null, current: payload.termsCurrent });
      }
    } catch {
      // Both stay null — "don't block", the same posture as the key status.
      // Safe because the modal is UX, not enforcement: requireUser 403s every
      // gated request regardless of what the browser believes.
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
        setTermsStatus(null);
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

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpResult> => {
    if (!supabase) return { error: 'Offline mode — no auth configured' };
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: publicOrigin() },
    });
    if (error) {
      // Production has self-signup switched off in the dashboard; GoTrue's
      // wording for that is not something a visitor should have to decode.
      return {
        error: /signups? not allowed/i.test(error.message)
          ? 'Accounts are created by invitation — check your inbox for an invite link.'
          : error.message,
      };
    }
    // A session means we are signed in and onAuthStateChange takes it from
    // here; no session means confirmations are on and the email is in flight.
    return { error: null, pendingConfirmation: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    clearCompletedIds(session?.user.id ?? null);
    await supabase.auth.signOut();
  }, [session]);

  const resetPassword = useCallback(async (email: string): Promise<string | null> => {
    if (!supabase) return 'Offline mode — no auth configured';
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: publicOrigin(),
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
    /** Coach model pick (phase 38): null clears it, falling back to the app default. */
    coachModel?: string | null;
    /** HR-zone settings (phase 35): null clears a value. */
    maxHr?: number | null; thresholdHr?: number | null;
  }): Promise<boolean> => {
    if (!supabase) return false;
    try {
      await patchJson('/api/profile', {
        ...(fields.displayName !== undefined ? { display_name: fields.displayName } : {}),
        ...(fields.avatarKey !== undefined ? { avatar_key: fields.avatarKey } : {}),
        ...(fields.coachGoal !== undefined ? { coach_goal: fields.coachGoal } : {}),
        ...(fields.coachContext !== undefined ? { coach_context: fields.coachContext } : {}),
        ...(fields.coachModel !== undefined ? { coach_model: fields.coachModel } : {}),
        ...(fields.maxHr !== undefined ? { max_hr: fields.maxHr } : {}),
        ...(fields.thresholdHr !== undefined ? { threshold_hr: fields.thresholdHr } : {}),
      }, 'Updating profile');
      // Optimistic local apply; the row is ours alone, no reconciliation needed.
      setProfile(prev => prev && {
        ...prev,
        ...(fields.displayName !== undefined ? { display_name: fields.displayName } : {}),
        ...(fields.avatarKey !== undefined ? { avatar_key: fields.avatarKey } : {}),
        ...(fields.coachGoal !== undefined ? { coach_goal: fields.coachGoal } : {}),
        ...(fields.coachContext !== undefined ? { coach_context: fields.coachContext } : {}),
        ...(fields.coachModel !== undefined ? { coach_model: fields.coachModel } : {}),
        ...(fields.maxHr !== undefined ? { max_hr: fields.maxHr } : {}),
        ...(fields.thresholdHr !== undefined ? { threshold_hr: fields.thresholdHr } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  // Optimistic and fire-and-forget: the flow closes on click regardless. A
  // failed PATCH just means it reappears on the next load, which beats
  // trapping the user behind a spinner in a modal they're trying to leave.
  const dismissOnboarding = useCallback(async () => {
    if (!supabase) return;
    setProfile(prev => prev && { ...prev, onboarding_dismissed_at: new Date().toISOString() });
    try {
      await patchJson('/api/profile', { onboarding_dismissed: true }, 'Saving');
    } catch {
      /* patchJson already toasted */
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

  // Called from three places: the sign-up form, the set-password form (the
  // invite path, which is how accounts are actually made), and the blocking
  // re-acceptance modal. All three land in the same append-only ledger.
  const acceptTerms = useCallback(async (): Promise<string | null> => {
    if (!supabase) return 'Offline mode — no auth configured';
    try {
      const { accepted } = await postAcceptance();
      setTermsStatus({ accepted, current: true });
      return null;
    } catch (err) {
      return err instanceof ApiError && err.message ? err.message : 'Failed to record acceptance';
    }
  }, []);

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

  const value = useMemo<AuthContextValue>(() => ({
    status,
    session,
    profile,
    anthropicKey,
    termsStatus,
    linkError: initialLinkError,
    signIn,
    signUp,
    signOut,
    resetPassword,
    setNewPassword,
    updateProfile,
    dismissOnboarding,
    refreshProfile,
    saveAnthropicKey,
    removeAnthropicKey,
    acceptTerms,
  }), [
    status, session, profile, anthropicKey, termsStatus, signIn, signUp, signOut, resetPassword,
    setNewPassword, updateProfile, dismissOnboarding, refreshProfile, saveAnthropicKey,
    removeAnthropicKey, acceptTerms,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
