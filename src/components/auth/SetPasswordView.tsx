import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

// Set-a-password screen, reached two ways with an active session already in
// place: a dashboard invite link (first login) or a password recovery link.
// autocomplete="new-password" prompts the platform password manager to
// generate and save the credential (which is what enables Face ID / Touch ID
// sign-in later).

export default function SetPasswordView() {
  const { setNewPassword, session, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const err = await setNewPassword(password);
    if (err) setError(err);
    setIsSubmitting(false);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="top-nav__logo">APEX</span>
          <span className="top-nav__sub">Training</span>
        </div>

        <p className="auth-note">
          Set a password for {session?.user.email ?? 'your account'}.
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
          {/* Hidden username field gives password managers the account
              identity to store alongside the generated password. */}
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={session?.user.email ?? ''}
            readOnly
            hidden
          />
          <label className="auth-field">
            <span className="auth-field__label">New password</span>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="auth-input"
            />
          </label>
          <label className="auth-field">
            <span className="auth-field__label">Confirm password</span>
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              className="auth-input"
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Set password'}
          </button>
          <button type="button" className="auth-link" onClick={() => signOut()}>
            Cancel and sign out
          </button>
        </form>
      </div>
    </div>
  );
}
