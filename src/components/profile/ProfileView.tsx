import { useEffect, useState } from 'react';
import { X, Check, Copy, LogOut } from 'lucide-react';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { useAuth } from '../../context/AuthContext';
import { AVATARS, AVATAR_KEYS } from '../../lib/profile/avatars';
import { postJson } from '../../lib/api';
import { notify } from '../../lib/notify';
import type { AvatarKey } from '../../lib/db/types';

// Full-screen profile overlay, same pattern as LibraryView: fixed inset-0,
// Escape closes, body scroll locked while open.

export default function ProfileView() {
  const { dispatch } = useCalendar();
  const { refreshEvents } = useSchedule();
  const { session, profile, signOut, setNewPassword, updateProfile, refreshProfile } = useAuth();
  const close = () => dispatch({ type: 'CLOSE_PROFILE' });

  const [name, setName] = useState(profile?.display_name ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [isCopyingTemplate, setIsCopyingTemplate] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile?.display_name) return;
    const ok = await updateProfile({ displayName: trimmed });
    if (ok) notify('Name updated');
  };

  const pickAvatar = (key: AvatarKey) => {
    if (key === profile?.avatar_key) return;
    updateProfile({ avatarKey: key });
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setPasswordMsg('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setPasswordMsg('Passwords do not match.'); return; }
    const err = await setNewPassword(password);
    if (err) { setPasswordMsg(err); return; }
    setPassword('');
    setConfirm('');
    setPasswordMsg('Password updated.');
  };

  const feedUrl = profile
    ? `${window.location.origin}/api/calendar-feed?token=${profile.ics_token}`
    : null;

  const copyFeedUrl = async () => {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      notify('Feed URL copied');
    } catch {
      notify('Copy failed');
    }
  };

  const copyTemplate = async () => {
    setIsCopyingTemplate(true);
    try {
      const result = await postJson<{ events?: number; alreadyCopied?: boolean }>(
        '/api/template-copy', {}, 'Copying starter workouts',
      );
      await Promise.all([refreshEvents(), refreshProfile()]);
      notify(result.alreadyCopied ? 'Already copied' : `Added ${result.events ?? 0} recurring workouts`);
    } catch {
      /* postJson already toasted */
    } finally {
      setIsCopyingTemplate(false);
    }
  };

  const showTemplateOffer = !!profile && !profile.is_template_source && !profile.template_copied_at;

  return (
    <div className="profile-view">
      <header className="library-header">
        <div className="library-header__titles">
          <span className="library-header__title">Profile</span>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={close} aria-label="Close profile">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="profile-body">
        <section className="profile-section">
          <h3 className="profile-section__title">Avatar</h3>
          <div className="profile-avatars">
            {AVATAR_KEYS.map(key => (
              <button
                key={key}
                className={`profile-avatar${profile?.avatar_key === key ? ' profile-avatar--active' : ''}`}
                onClick={() => pickAvatar(key)}
                title={AVATARS[key].label}
              >
                <img src={AVATARS[key].src} alt={AVATARS[key].label} />
                {profile?.avatar_key === key && (
                  <span className="profile-avatar__check"><Check size={12} strokeWidth={3} /></span>
                )}
              </button>
            ))}
          </div>
        </section>

        <section className="profile-section">
          <h3 className="profile-section__title">Account</h3>
          <label className="auth-field">
            <span className="auth-field__label">Name</span>
            <input
              className="auth-input"
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              maxLength={80}
            />
          </label>
          <label className="auth-field">
            <span className="auth-field__label">Email</span>
            <input className="auth-input" value={session?.user.email ?? ''} readOnly disabled />
          </label>
        </section>

        <section className="profile-section">
          <h3 className="profile-section__title">Change password</h3>
          <form className="auth-form" onSubmit={changePassword}>
            <label className="auth-field">
              <span className="auth-field__label">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                className="auth-input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </label>
            <label className="auth-field">
              <span className="auth-field__label">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                className="auth-input"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
              />
            </label>
            {passwordMsg && <p className="profile-msg">{passwordMsg}</p>}
            <button type="submit" className="auth-submit">Update password</button>
          </form>
        </section>

        <section className="profile-section">
          <h3 className="profile-section__title">Calendar feed</h3>
          <p className="profile-hint">
            Subscribe from Apple/Google Calendar to see your workouts. Anyone with
            this URL can read your schedule — treat it like a password.
          </p>
          <div className="profile-feed">
            <input className="auth-input profile-feed__url" value={feedUrl ?? ''} readOnly />
            <button className="btn-today" onClick={copyFeedUrl} title="Copy feed URL">
              <Copy size={14} strokeWidth={1.5} />
            </button>
          </div>
        </section>

        {showTemplateOffer && (
          <section className="profile-section">
            <h3 className="profile-section__title">Starter plan</h3>
            <p className="profile-hint">
              Copy Shane's recurring workouts onto your calendar as a starting
              place. One-time — you can edit or delete everything afterwards.
            </p>
            <button className="auth-submit" onClick={copyTemplate} disabled={isCopyingTemplate}>
              {isCopyingTemplate ? 'Copying…' : "Copy Shane's recurring workouts"}
            </button>
          </section>
        )}

        <section className="profile-section">
          <button className="profile-signout" onClick={() => signOut()}>
            <LogOut size={14} strokeWidth={1.5} />
            Sign out
          </button>
        </section>
      </div>
    </div>
  );
}
