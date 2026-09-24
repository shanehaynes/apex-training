import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useAuth } from '../../context/auth';
import { useOnboardingActions } from '../../hooks/useOnboardingActions';
import { WELCOME_STEPS } from '../../lib/onboarding/content';

// First-run intro: four cards that get a new user to a first logged workout
// and a working coach, nothing more — every other feature is taught by a tip
// the first time it is reached (docs/onboarding/MASTER.md, "Intro"). Shows
// once per account: finishing or skipping latches
// profiles.onboarding_dismissed_at, so it does not come back on the next
// device either.
//
// Same portal + backdrop + motion shape as DayModal, deliberately — a new
// user meets this before anything else, and it should look like the app.

export default function WelcomeFlow() {
  const { dismissOnboarding } = useAuth();
  const { run, isBusy, corosConfigured } = useOnboardingActions();
  const [index, setIndex] = useState(0);

  // No card needs COROS today, but the field stays in the contract: a watch
  // card is a promise a deployment without COROS env vars cannot keep.
  const steps = WELCOME_STEPS.filter(step => !step.requiresCoros || corosConfigured);
  const step = steps[index];
  const isLast = index === steps.length - 1;

  const close = () => { void dismissOnboarding(); };

  // No backdrop onClick, unlike DayModal: this shows exactly once per account
  // and a stray click outside shouldn't spend it.
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
        aria-labelledby="welcome-title"
        initial={{ opacity: 0, scale: 0.94, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        <button className="modal-close welcome__skip" onClick={close} aria-label="Skip setup">
          <X size={18} strokeWidth={1.5} />
        </button>

        <div className="welcome__body">
          <h2 id="welcome-title" className="welcome__title">{step.title}</h2>
          <p className="welcome__text">{withBold(step.body)}</p>

          {step.action && (
            <button
              className="auth-submit welcome__action"
              onClick={() => run(step.action!.kind)}
              disabled={isBusy(step.action.kind)}
            >
              {step.action.label}
            </button>
          )}

          {step.link && (
            <a
              className="welcome__link"
              href={step.link.href}
              target="_blank"
              rel="noreferrer"
            >
              {step.link.label}
            </a>
          )}
        </div>

        <div className="welcome__footer">
          {/* Four dots read as position on a phone without a "Step N of M"
              line (iOS dropped it too, D-042); the label keeps it for a
              screen reader. */}
          <div className="welcome__dots" role="img" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <span key={s.id} className={`welcome__dot${i === index ? ' welcome__dot--active' : ''}`} />
            ))}
          </div>
          <div className="welcome__nav">
            {index > 0 && (
              <button className="welcome__back" onClick={() => setIndex(i => i - 1)}>Back</button>
            )}
            <button
              className="auth-submit welcome__next"
              onClick={() => (isLast ? close() : setIndex(i => i + 1))}
            >
              {isLast ? 'Start training' : 'Next'}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** `**Label**` → <strong>: copy names a button by its on-screen label in bold. */
function withBold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
}
