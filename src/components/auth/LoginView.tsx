import { useState } from 'react';
import { useAuth } from '../../context/auth';
import AcceptanceCheckbox from '../legal/AcceptanceCheckbox';

// Email + password sign-in and create-account, one card, one form. A real
// <form> with name/autocomplete attributes is what makes iCloud Keychain /
// Google Password Manager save the login and offer Face ID / Touch ID unlock
// on return visits — don't replace it with div-and-onClick.
//
// Accounts are invite-only (dashboard); the create side says so up front and
// the context maps GoTrue's "signups not allowed" into plain words. The two
// primary modes share the email/password fields and differ only in button
// label, password autocomplete, and that one note — a segmented toggle, not
// a second form, keeps the card from growing.

type Mode = 'signIn' | 'create' | 'reset' | 'resetSent' | 'confirmSent';

export default function LoginView() {
  const { signIn, signUp, resetPassword, acceptTerms, linkError } = useAuth();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(linkError);
  const [accepted, setAccepted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const err = await signIn(email, password);
    if (err) setError(err);
    setIsSubmitting(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    // Belt and braces alongside the disabled button: a form can still be
    // submitted by pressing Enter in a field, and the button's disabled
    // attribute is one devtools edit away. The server gate is what actually
    // enforces this — see requireUser in api/_lib/auth.ts.
    if (!accepted) {
      setError('Please accept the Terms of Service and Privacy Policy to continue.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const result = await signUp(email, password);
    if (result.error !== null) {
      setError(result.error);
    } else if (result.pendingConfirmation) {
      // No session yet (email confirmations on), so there is no JWT to write
      // the acceptance with. The record lands on first sign-in instead, via
      // the gate modal — the alternative would be an unauthenticated write
      // to the ledger, which is worth less than no record at all.
      setMode('confirmSent');
    } else {
      // A session landed: record the acceptance now, while the click that
      // produced it is the thing being recorded.
      await acceptTerms();
    }
    setIsSubmitting(false);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const err = await resetPassword(email);
    if (err) setError(err);
    else setMode('resetSent');
    setIsSubmitting(false);
  };

  const isCreate = mode === 'create';
  const submitHandler = isCreate ? handleCreate : mode === 'signIn' ? handleSignIn : handleReset;
  const submitLabel = isCreate
    ? (isSubmitting ? 'Creating…' : 'Create account')
    : mode === 'signIn'
      ? (isSubmitting ? 'Signing in…' : 'Sign in')
      : (isSubmitting ? 'Sending…' : 'Send reset link');

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="top-nav__logo">APEX</span>
          <span className="top-nav__sub">Training</span>
        </div>

        {(mode === 'signIn' || mode === 'create') && (
          <div className="auth-toggle" role="group" aria-label="Sign in or create account">
            <button
              type="button"
              className="auth-toggle__option"
              aria-pressed={mode === 'signIn'}
              onClick={() => switchTo('signIn')}
            >
              Sign in
            </button>
            <button
              type="button"
              className="auth-toggle__option"
              aria-pressed={mode === 'create'}
              onClick={() => switchTo('create')}
            >
              Create account
            </button>
          </div>
        )}

        {mode === 'resetSent' ? (
          <>
            <p className="auth-note">
              If an account exists for {email}, a password reset link is on its way.
              The link expires in 24 hours.
            </p>
            <button type="button" className="auth-link" onClick={() => switchTo('signIn')}>
              Back to sign in
            </button>
          </>
        ) : mode === 'confirmSent' ? (
          <>
            <p className="auth-note">
              Check {email} for a confirmation link to finish creating your account.
            </p>
            <button type="button" className="auth-link" onClick={() => switchTo('signIn')}>
              Back to sign in
            </button>
          </>
        ) : (
          <form className="auth-form" onSubmit={submitHandler}>
            {isCreate && (
              <p className="auth-hint">Account creation is invite only.</p>
            )}

            <label className="auth-field">
              <span className="auth-field__label">Email</span>
              <input
                type="email"
                name="email"
                autoComplete={isCreate ? 'username' : 'email'}
                inputMode="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="auth-input"
              />
            </label>

            {mode !== 'reset' && (
              <label className="auth-field">
                <span className="auth-field__label">Password</span>
                <input
                  // Keyed so the browser treats create/sign-in as different
                  // fields: "new-password" is what prompts the password
                  // manager to generate one instead of autofilling a saved one.
                  key={isCreate ? 'new' : 'current'}
                  type="password"
                  name="password"
                  autoComplete={isCreate ? 'new-password' : 'current-password'}
                  required
                  minLength={isCreate ? 8 : undefined}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="auth-input"
                />
              </label>
            )}

            {isCreate && (
              <AcceptanceCheckbox
                id="accept-legal-signup"
                checked={accepted}
                onChange={setAccepted}
                disabled={isSubmitting}
              />
            )}

            {error && <p className="auth-error">{error}</p>}

            <button
              type="submit"
              className="auth-submit"
              disabled={isSubmitting || (isCreate && !accepted)}
            >
              {submitLabel}
            </button>

            {mode === 'signIn' && (
              <button type="button" className="auth-link" onClick={() => switchTo('reset')}>
                Forgot password?
              </button>
            )}
            {mode === 'reset' && (
              <button type="button" className="auth-link" onClick={() => switchTo('signIn')}>
                Back to sign in
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
