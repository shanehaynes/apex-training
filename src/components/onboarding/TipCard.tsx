import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import type { TipDefinition } from '../../lib/onboarding/tips/index';
import { tipBodySegments } from '../../lib/onboarding/tipHost';
import { helpPath } from '../../lib/help/pages';

// One tip, as a card (a bottom sheet on a phone) on the WelcomeFlow shape:
// portal + motion backdrop + .modal (D-O02). The copy names the button it is
// about; the card never points at it.
//
// Deliberately not useModalChrome: its body scroll lock is last-writer-wins,
// so closing a tip over the tracker would unlock the tracker's page beneath.
// A tip is short and needs no scrolling, so it takes no lock at all.

interface Props {
  tip: TipDefinition;
  /** The user is done with it — either button, or a tap outside. */
  onDone: () => void;
}

export default function TipCard({ tip, onDone }: Props) {
  const okRef = useRef<HTMLButtonElement>(null);

  // Focus the one obvious answer; hand focus back to wherever it was when the
  // card goes, so a keyboard user resumes where the tip interrupted them.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    okRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  // Escape does nothing — not even to the overlay underneath, whose own
  // Escape handler would otherwise close it behind the user's back. Capture
  // on window runs before any target or bubble listener.
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', swallow, true);
    return () => { window.removeEventListener('keydown', swallow, true); };
  }, []);

  const titleId = `tip-title-${tip.id}`;

  return createPortal(
    <motion.div
      className="modal-backdrop modal-backdrop--tip"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      // A tap outside is "Got it": for a user who does not know what the
      // card wants, dismissing it must be the easiest thing on the screen.
      onClick={e => { if (e.target === e.currentTarget) onDone(); }}
    >
      <motion.div
        className="modal tip"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-tip-id={tip.id}
        initial={{ opacity: 0, scale: 0.94, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        <h2 id={titleId} className="tip__title">{tip.title}</h2>
        <p className="tip__text">
          {tipBodySegments(tip.body).map((seg, i) => (seg.bold ? <strong key={i}>{seg.text}</strong> : seg.text))}
        </p>

        <div className="tip__actions">
          {tip.help && (
            <a
              className="tip__link"
              href={helpPath(tip.help)}
              target="_blank"
              rel="noreferrer"
              // Deferred a tick: removing the link inside its own click
              // handler can cancel the navigation (a disconnected anchor
              // does not follow its href).
              onClick={() => { setTimeout(onDone, 0); }}
            >
              Show me how
            </a>
          )}
          <button ref={okRef} type="button" className="auth-submit tip__ok" onClick={onDone}>
            Got it
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
