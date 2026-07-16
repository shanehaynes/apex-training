import { useEffect, useState } from 'react';
import { X, Check, Copy, LogOut } from 'lucide-react';
import { useCalendar } from '../../context/CalendarContext';
import { useSchedule } from '../../context/ScheduleContext';
import { useAuth } from '../../context/AuthContext';
import { AVATARS, AVATAR_KEYS } from '../../lib/profile/avatars';
import { postJson } from '../../lib/api';
import { notify } from '../../lib/notify';
import { useRotatingPlaceholder } from '../../hooks/useRotatingPlaceholder';
import type { AvatarKey } from '../../lib/db/types';

// Full-screen profile overlay, same pattern as LibraryView: fixed inset-0,
// Escape closes, body scroll locked while open.

// Ghost-text examples for the coach fields. The context rotation is offset
// 4s from the goal's so the two placeholders never swap at the same moment.
const GOAL_EXAMPLES = [
  'Summit Everest',
  'Win a local bodybuilding competition',
  'Climb 5.13a',
  'Run a sub-3-hour marathon',
];
const CONTEXT_EXAMPLES = [
  'I am 54 with a history of lower back pain',
  'I am a sprinter with shin splints',
  'I am trying to fix a muscular asymmetry',
];

export default function ProfileView() {
  const { dispatch } = useCalendar();
  const { refreshEvents } = useSchedule();
  const {
    session, profile, anthropicKey, signOut, setNewPassword, updateProfile,
    refreshProfile, saveAnthropicKey, removeAnthropicKey,
  } = useAuth();
  const close = () => dispatch({ type: 'CLOSE_PROFILE' });

  const [name, setName] = useState(profile?.display_name ?? '');
  const [goal, setGoal] = useState(profile?.coach_goal ?? '');
  const [coachContext, setCoachContext] = useState(profile?.coach_context ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [isCopyingTemplate, setIsCopyingTemplate] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isReplacingKey, setIsReplacingKey] = useState(false);

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

  // Unlike saveName, empty is a valid save — clearing a coach field is an edit.
  const saveGoal = async () => {
    const trimmed = goal.trim();
    if (trimmed === (profile?.coach_goal ?? '')) return;
    const ok = await updateProfile({ coachGoal: trimmed });
    if (ok) notify('Goal updated');
  };

  const saveCoachContext = async () => {
    const trimmed = coachContext.trim();
    if (trimmed === (profile?.coach_context ?? '')) return;
    const ok = await updateProfile({ coachContext: trimmed });
    if (ok) notify('Context updated');
  };

  const goalPlaceholder = useRotatingPlaceholder(GOAL_EXAMPLES);
  const contextPlaceholder = useRotatingPlaceholder(CONTEXT_EXAMPLES, { offsetMs: 4000 });

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

  const submitKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = keyInput.trim();
    if (!key) return;
    setIsSavingKey(true);
    setKeyMsg(null);
    const err = await saveAnthropicKey(key);
    if (err) {
      setKeyMsg(err);
    } else {
      setKeyInput('');
      setIsReplacingKey(false);
      notify('API key saved');
    }
    setIsSavingKey(false);
  };

  const removeKey = async () => {
    setKeyMsg(null);
    const ok = await removeAnthropicKey();
    if (ok) notify('API key removed');
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
          <h3 className="profile-section__title">AI Coach</h3>
          <p className="profile-hint">
            Tell the coach what you're training for — it shapes every chat and
            post-workout summary.
          </p>
          <label className="auth-field">
            <span className="auth-field__label">Goal</span>
            <input
              className="auth-input"
              value={goal}
              onChange={e => setGoal(e.target.value)}
              onBlur={saveGoal}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              maxLength={200}
              placeholder={goalPlaceholder}
            />
          </label>
          <label className="auth-field">
            <span className="auth-field__label">Additional context</span>
            <textarea
              className="auth-input auth-input--textarea"
              value={coachContext}
              onChange={e => setCoachContext(e.target.value)}
              onBlur={saveCoachContext}
              maxLength={1000}
              rows={3}
              placeholder={contextPlaceholder}
            />
          </label>
          {anthropicKey === null ? (
            <p className="profile-hint">Checking key status…</p>
          ) : anthropicKey.hasKey && !isReplacingKey ? (
            <>
              <p className="profile-hint">
                The coach runs on your own Anthropic API key. Yours is saved.
              </p>
              <div className="profile-feed">
                <input
                  className="auth-input profile-feed__url"
                  value={`sk-ant-…${anthropicKey.last4 ?? ''}`}
                  readOnly
                  aria-label="Saved API key (masked)"
                />
                <button className="btn-today" onClick={() => { setIsReplacingKey(true); setKeyMsg(null); }}>
                  Replace
                </button>
                <button className="btn-today" onClick={removeKey}>
                  Remove
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="profile-hint">
                The coach chat and post-workout summaries run on your own
                Anthropic API key (create one at console.anthropic.com →
                Settings → API keys). It's stored server-side and never shown
                in full again.
              </p>
              <form className="auth-form" onSubmit={submitKey}>
                <input
                  type="password"
                  autoComplete="off"
                  className="auth-input"
                  placeholder="sk-ant-…"
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  aria-label="Anthropic API key"
                />
                {keyMsg && <p className="auth-error">{keyMsg}</p>}
                <div className="profile-feed">
                  <button type="submit" className="auth-submit" disabled={isSavingKey || !keyInput.trim()}>
                    {isSavingKey ? 'Verifying…' : 'Save key'}
                  </button>
                  {isReplacingKey && (
                    <button type="button" className="btn-today" onClick={() => { setIsReplacingKey(false); setKeyInput(''); setKeyMsg(null); }}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
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
