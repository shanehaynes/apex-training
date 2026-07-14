import { useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useSchedule } from '../../context/ScheduleContext';
import { postJson } from '../../lib/api';
import { notify } from '../../lib/notify';

// One-time offer shown to fresh accounts: copy the template user's recurring
// workouts as a starting plan. Dismissal is local (per device) — the action
// stays reachable from ProfileView; a completed copy is recorded server-side
// (profiles.template_copied_at) and hides it everywhere.

const DISMISS_KEY = 'apex-template-offer-dismissed';

export default function TemplateOfferBanner() {
  const { profile, refreshProfile } = useAuth();
  const { refreshEvents } = useSchedule();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [isCopying, setIsCopying] = useState(false);

  if (!profile || profile.is_template_source || profile.template_copied_at || dismissed) {
    return null;
  }

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
    setDismissed(true);
  };

  const copyTemplate = async () => {
    setIsCopying(true);
    try {
      const result = await postJson<{ events?: number; alreadyCopied?: boolean }>(
        '/api/template-copy', {}, 'Copying starter workouts',
      );
      await Promise.all([refreshEvents(), refreshProfile()]);
      notify(result.alreadyCopied ? 'Already copied' : `Added ${result.events ?? 0} recurring workouts`);
    } catch {
      /* postJson already toasted */
    } finally {
      setIsCopying(false);
    }
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
