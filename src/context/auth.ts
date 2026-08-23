import { createContext, useContext } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { AvatarKey, ProfileRow } from '../lib/db/types';

// Context object + hook live apart from the provider so AuthContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

export type AuthStatus = 'offline' | 'loading' | 'signedOut' | 'needsPassword' | 'signedIn';

/** What the browser is allowed to know about the user's Anthropic key. */
export interface AnthropicKeyStatus {
  hasKey: boolean;
  last4: string | null;
}

/** Outcome of a sign-up attempt. `pendingConfirmation` means Supabase
 *  created the user but is holding the session until they click the email
 *  link (email confirmations on) — the caller shows a "check your inbox". */
export type SignUpResult =
  | { error: string }
  | { error: null; pendingConfirmation: boolean };

export interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  profile: ProfileRow | null;
  /** null = not yet loaded/unknown (don't block the coach UI on it). */
  anthropicKey: AnthropicKeyStatus | null;
  /** Error carried by an expired/used invite or recovery link, for LoginView. */
  linkError: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<string | null>;
  setNewPassword: (password: string) => Promise<string | null>;
  updateProfile: (fields: {
    displayName?: string; avatarKey?: AvatarKey; coachGoal?: string; coachContext?: string;
  }) => Promise<boolean>;
  /** Latch the welcome flow closed for good, on every device. */
  dismissOnboarding: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Save/replace the user's Anthropic API key. Returns an error message, or null on success. */
  saveAnthropicKey: (key: string) => Promise<string | null>;
  removeAnthropicKey: () => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
