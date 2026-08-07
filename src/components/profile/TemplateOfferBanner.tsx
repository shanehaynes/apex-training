import { useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTemplateCopy } from '../../hooks/useTemplateCopy';

// One-time offer shown to fresh accounts: copy the template user's recurring
// workouts as a starting plan. Dismissal is local (per device) — the action
// stays reachable from ProfileView; a completed copy is recorded server-side
// (profiles.template_copied_at) and hides it everywhere.

const DISMISS_KEY = 'apex-template-offer-dismissed';

export default function TemplateOfferBanner() {
  const { profile } = useAuth();
  const { copyTemplate, isCopying } = useTemplateCopy();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  if (!profile || profile.is_template_source || profile.template_copied_at || dismissed) {
    return null;
  }

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
    setDismissed(true);
  };

  return (
    <div className="template-offer" role="status">
      <div className="template-offer__text">
        <strong>New here?</strong> Copy Shane's recurring workouts onto your
        calendar as a starting place — you can edit or delete everything after.
      </div>
      <div className="template-offer__actions">
        <button className="auth-submit template-offer__copy" onClick={copyTemplate} disabled={isCopying}>
          {isCopying ? 'Copying…' : 'Copy workouts'}
        </button>
        <button className="template-offer__dismiss" onClick={dismiss} aria-label="Dismiss">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
