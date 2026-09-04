import { useState } from 'react';
import { useAuth } from '../../context/auth';
import AcceptanceCheckbox from '../legal/AcceptanceCheckbox';
import OpenInAppButton from './OpenInAppButton';

// Set-a-password screen, reached two ways with an active session already in
// place: a dashboard invite link (first login) or a password recovery link.
// autocomplete="new-password" prompts the platform password manager to
// generate and save the credential (which is what enables Face ID / Touch ID
// sign-in later).

export default function SetPasswordView() {
  const { setNewPassword, acceptTerms, termsStatus, session, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Recovery links reach this screen too, and an existing user resetting a
  // password has already accepted — asking again would be noise. The
  // checkbox appears only when the ledger has nothing current for them,
  // which for an invited user is always.
  const needsAcceptance = termsStatus === null || !termsStatus.current;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needsAcceptance && !accepted) {
      setError('Please accept the Terms of Service and Privacy Policy to continue.');
      return;
    }
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
    if (err) {
      setError(err);
      setIsSubmitting(false);
      return;
    }
    // After the password lands, not before: the session is already valid
    // here, but recording acceptance only once the account is genuinely
    // usable keeps the ledger free of rows for abandoned set-ups.
    if (needsAcceptance) {
      const acceptErr = await acceptTerms();
      // Non-fatal: the account works, and the gate modal will ask again on
      // the next load. Better than stranding them on this screen.
      if (acceptErr) console.warn('[apex] acceptance not recorded at set-password:', acceptErr);
    }
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

        {/* An invite or recovery link opened on a phone with the app installed
            can finish there instead (D-020); everywhere else this renders nothing. */}
        <OpenInAppButton />

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

          {needsAcceptance && (
            <AcceptanceCheckbox
              id="accept-legal-invite"
              checked={accepted}
              onChange={setAccepted}
              disabled={isSubmitting}
            />
          )}

          {error && <p className="auth-error">{error}</p>}

          <button
            type="submit"
            className="auth-submit"
            disabled={isSubmitting || (needsAcceptance && !accepted)}
          >
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
