import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/auth';
import { deleteAccount, downloadAccountExport } from '../../lib/api';
import { LEGAL_DOCUMENTS } from '../../lib/legal/versions';

// Export and delete — the two capabilities legal/privacy-v1.md §6 promises.
// They exist because the policy says they do; writing "you may request
// deletion" over a system with no delete path would have been the dishonest
// version of this feature.
//
// Deletion asks the user to type their email rather than clicking a second
// "are you sure". A confirmation click is muscle memory; transcribing the
// address is a deliberate act, and it also proves they know which account
// they are standing in — which matters on a shared machine.

export default function AccountData() {
  const { session, termsStatus, signOut } = useAuth();
  const email = session?.user.email ?? '';
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const runExport = async () => {
    setIsExporting(true);
    try {
      await downloadAccountExport();
    } catch {
      /* downloadAccountExport already toasted */
    }
    setIsExporting(false);
  };

  const runDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      // The auth user is gone, so the session's JWT no longer resolves.
      // Signing out clears it locally and drops us back to LoginView rather
      // than leaving a dead session pointed at a deleted account.
      await signOut();
    } catch {
      setError('Deletion failed. Nothing was removed — try again, or get in touch.');
      setIsDeleting(false);
    }
  };

  return (
    <section className="profile-section">
      <h3 className="profile-section__title">Your data</h3>

      <p className="profile-hint">
        Everything Apex holds about you, and how to take it back. See the{' '}
        {LEGAL_DOCUMENTS.map((doc, i) => (
          <span key={doc.slug}>
            {i > 0 ? ' and ' : ''}
            <a href={doc.path} target="_blank" rel="noreferrer">{doc.title}</a>
          </span>
        ))}
        {termsStatus?.accepted
          ? ` — you accepted ${termsStatus.accepted.termsVersion} on ${new Date(termsStatus.accepted.acceptedAt).toLocaleDateString()}.`
          : '.'}
      </p>

      <button className="btn-today account-data__action" onClick={runExport} disabled={isExporting}>
        <Download size={14} strokeWidth={1.5} />
        {isExporting ? 'Preparing…' : 'Export my data (JSON)'}
      </button>

      <p className="profile-hint account-data__danger-note">
        Deleting your account removes your schedule, logs, meals, imported watch
        activities, and review history permanently. It cannot be undone, and we
        cannot recover it for you. Export first if you want a copy.
      </p>

      {!confirmOpen ? (
        <button
          className="btn-today account-data__danger"
          onClick={() => { setConfirmOpen(true); setError(null); }}
        >
          <Trash2 size={14} strokeWidth={1.5} />
          Delete my account
        </button>
      ) : (
        <div className="account-data__confirm">
          <label className="auth-field">
            <span className="auth-field__label">Type {email} to confirm</span>
            <input
              className="auth-input"
              value={typed}
              autoComplete="off"
              onChange={e => setTyped(e.target.value)}
              disabled={isDeleting}
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <div className="account-data__confirm-actions">
            <button
              className="btn-today account-data__danger"
              disabled={typed.trim() !== email || isDeleting}
              onClick={runDelete}
            >
              {isDeleting ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button
              className="btn-today"
              disabled={isDeleting}
              onClick={() => { setConfirmOpen(false); setTyped(''); setError(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
