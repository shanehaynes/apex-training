import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../../context/auth';
import AcceptanceCheckbox from './AcceptanceCheckbox';
import { LEGAL_DOCUMENTS } from '../../lib/legal/versions';

// The re-acceptance gate: shown when the signed-in user's latest acceptance
// is missing or names an older version than the one deployed.
//
// Deliberately NOT dismissible — no close button, no backdrop click, no
// Escape. Same portal/backdrop shape as WelcomeFlow, but the opposite
// contract: the welcome flow is a courtesy that a stray click should be able
// to spend, and this is the thing standing between the user and an app whose
// every write the server will 403 anyway. A dismissible version would just
// produce a session of failed requests with no explanation.
//
// Rendered ABOVE the data providers in App.tsx, so nothing fetches while it
// is up — otherwise mounting the calendar would fire a dozen gated reads and
// bury the modal under failure toasts.
//
// The only ways out are accepting, or signing out.

export default function TermsGate() {
  const { acceptTerms, signOut, termsStatus, session } = useAuth();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isReturning = termsStatus?.accepted != null;

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    const err = await acceptTerms();
    if (err) setError(err);
    setIsSubmitting(false);
  };

  return createPortal(
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="modal welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terms-gate-title"
        initial={{ opacity: 0, scale: 0.94, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="welcome__body">
          <h2 id="terms-gate-title" className="welcome__title">
            {isReturning ? 'Our terms have changed' : 'Before you start'}
          </h2>
          <p className="welcome__text">
            {isReturning
              ? 'We have published updated documents. Please read them and accept to keep using Apex.'
              : 'Apex needs your agreement to two short documents before it can load your training data.'}
          </p>
          {isReturning && termsStatus?.accepted && (
            <p className="welcome__text legal-accept__previous">
              You previously accepted {termsStatus.accepted.termsVersion} and{' '}
              {termsStatus.accepted.privacyVersion} on{' '}
              {new Date(termsStatus.accepted.acceptedAt).toLocaleDateString()}. That record is kept;
              accepting now adds a new one.
            </p>
          )}

          <ul className="legal-accept__summary">
            {LEGAL_DOCUMENTS.map(doc => (
              <li key={doc.slug}>
                <a href={doc.path} target="_blank" rel="noreferrer">{doc.title}</a>
                {' — '}
                <span className="legal-accept__versions">{doc.version}</span>
              </li>
            ))}
          </ul>

          <AcceptanceCheckbox
            id="accept-legal-gate"
            checked={checked}
            onChange={setChecked}
            disabled={isSubmitting}
          />

          {error && <p className="auth-error">{error}</p>}

          <button
            type="button"
            className="auth-submit welcome__action"
            disabled={!checked || isSubmitting}
            onClick={submit}
          >
            {isSubmitting ? 'Recording…' : 'Accept and continue'}
          </button>
          <button type="button" className="auth-link" onClick={() => signOut()}>
            Sign out{session?.user.email ? ` (${session.user.email})` : ''}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
