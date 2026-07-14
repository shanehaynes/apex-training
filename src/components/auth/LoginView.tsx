import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

// Email + password sign-in. A real <form> with name/autocomplete attributes
// is what makes iCloud Keychain / Google Password Manager save the login and
// offer Face ID / Touch ID unlock on return visits — don't replace it with
// div-and-onClick. Signup is invite-only (dashboard), so there is no
// create-account path here.

type Mode = 'signIn' | 'reset' | 'resetSent';

export default function LoginView() {
  const { signIn, resetPassword, linkError } = useAuth();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(linkError);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const err = await signIn(email, password);
    if (err) setError(err);
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

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="top-nav__logo">APEX</span>
          <span className="top-nav__sub">Training</span>
        </div>

        {mode === 'resetSent' ? (
          <>
            <p className="auth-note">
              If an account exists for {email}, a password reset link is on its way.
              The link expires in 24 hours.
            </p>
            <button type="button" className="auth-link" onClick={() => setMode('signIn')}>
              Back to sign in
            </button>
          </>
        ) : (
          <form className="auth-form" onSubmit={mode === 'signIn' ? handleSignIn : handleReset}>
            <label className="auth-field">
              <span className="auth-field__label">Email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="auth-input"
              />
            </label>

            {mode === 'signIn' && (
              <label className="auth-field">
                <span className="auth-field__label">Password</span>
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="auth-input"
                />
              </label>
            )}

            {error && <p className="auth-error">{error}</p>}

            <button type="submit" className="auth-submit" disabled={isSubmitting}>
              {mode === 'signIn'
                ? (isSubmitting ? 'Signing in…' : 'Sign in')
                : (isSubmitting ? 'Sending…' : 'Send reset link')}
            </button>

            {mode === 'signIn' ? (
              <button type="button" className="auth-link" onClick={() => { setMode('reset'); setError(null); }}>
                Forgot password?
              </button>
            ) : (
              <button type="button" className="auth-link" onClick={() => { setMode('signIn'); setError(null); }}>
                Back to sign in
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
