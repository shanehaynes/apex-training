import { useState } from 'react';
import { useModalChrome } from '../../hooks/useModalChrome';
import { X, Check, Copy, LogOut } from 'lucide-react';
import { useCalendar } from '../../context/calendar';
import { useAuth } from '../../context/auth';
import { AVATARS, AVATAR_KEYS } from '../../lib/profile/avatars';
import { notify } from '../../lib/notify';
import { publicOrigin } from '../../lib/origin';
import { useRotatingPlaceholder } from '../../hooks/useRotatingPlaceholder';
import GettingStarted from '../onboarding/GettingStarted';
import CoachActivity from './CoachActivity';
import McpTokens from './McpTokens';
import ConnectorGuide from './ConnectorGuide';
import CorosConnection from './CorosConnection';
import ProfileDisclosure from './ProfileDisclosure';
import type { AvatarKey } from '../../lib/db/types';

// Full-screen profile overlay, same pattern as LibraryView: fixed inset-0,
// Escape closes, body scroll locked while open.
//
// The body reads top-to-bottom as: who you are → what the coach knows →
// what Apex is connected to → what has been happening. Within each group the
// fields you revisit are laid out plainly and the set-once ones (password,
// API key, tokens, COROS, the activity log) sit behind ProfileDisclosure.

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
  const {
    session, profile, anthropicKey, signOut, setNewPassword, updateProfile,
    saveAnthropicKey, removeAnthropicKey,
  } = useAuth();
  const close = () => dispatch({ type: 'CLOSE_PROFILE' });

  const [name, setName] = useState(profile?.display_name ?? '');
  const [maxHr, setMaxHr] = useState(profile?.max_hr != null ? String(profile.max_hr) : '');
  const [thresholdHr, setThresholdHr] = useState(profile?.threshold_hr != null ? String(profile.threshold_hr) : '');
  const [goal, setGoal] = useState(profile?.coach_goal ?? '');
  const [coachContext, setCoachContext] = useState(profile?.coach_context ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isReplacingKey, setIsReplacingKey] = useState(false);

  const [showConnectorGuide, setShowConnectorGuide] = useState(false);

  // Escape backs out of the guide before it closes the profile, so the key
  // does what the on-screen back arrow does rather than skipping a level.
  useModalChrome(() => {
    if (showConnectorGuide) setShowConnectorGuide(false);
    else close();
  });

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile?.display_name) return;
    const ok = await updateProfile({ displayName: trimmed });
    if (ok) notify('Name updated');
  };

  // Blank clears (null); anything else must parse as a whole number in the
  // handler's bounds — the API 400s out-of-range values, so pre-check here.
  const saveHrField = (raw: string, current: number | null, bounds: [number, number], patch: (v: number | null) => Promise<boolean>, label: string) => async () => {
    const trimmed = raw.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value === current || (value === null && current === null)) return;
    if (value !== null && (!Number.isInteger(value) || value < bounds[0] || value > bounds[1])) {
      notify(`${label} must be a whole number between ${bounds[0]} and ${bounds[1]}`);
      return;
    }
    const ok = await patch(value);
    if (ok) notify(`${label} ${value === null ? 'cleared' : 'updated'}`);
  };

  const saveMaxHr = saveHrField(maxHr, profile?.max_hr ?? null, [100, 250], v => updateProfile({ maxHr: v }), 'Max HR');
  const saveThresholdHr = saveHrField(thresholdHr, profile?.threshold_hr ?? null, [80, 230], v => updateProfile({ thresholdHr: v }), 'Threshold HR');

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
    ? `${publicOrigin()}/api/calendar-feed?token=${profile.ics_token}`
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

  // Same shape as LibraryView → ExerciseDetail: the guide takes over the
  // overlay rather than stacking a second one, so there is only ever one
  // Escape/body-scroll owner.
  if (showConnectorGuide) {
    return <ConnectorGuide onBack={() => setShowConnectorGuide(false)} onClose={close} />;
  }

  const currentAvatar = profile?.avatar_key ? AVATARS[profile.avatar_key] : null;

  const keyStatus = anthropicKey === null
    ? 'Checking…'
    : anthropicKey.hasKey ? `Saved · …${anthropicKey.last4 ?? ''}` : 'Not set';

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
        {/* First: a new account's unfinished setup is the reason they opened
            this screen. Self-hides for the template source. */}
        <GettingStarted />

        <div className="profile-group">
          <h2 className="profile-group__title">You</h2>

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
            <h3 className="profile-section__title">Heart-rate zones</h3>
            <p className="profile-section__hint">
              Zone charts in Analytics use Friel LTHR bands when a threshold HR is
              set, %-of-max bands otherwise. Blank a field to clear it.
            </p>
            <div className="library-field-row">
              <label className="auth-field">
                <span className="auth-field__label">Threshold HR (LTHR)</span>
                <input
                  className="auth-input"
                  inputMode="numeric"
                  value={thresholdHr}
                  onChange={e => setThresholdHr(e.target.value)}
                  onBlur={saveThresholdHr}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  placeholder="e.g. 165"
                />
              </label>
              <label className="auth-field">
                <span className="auth-field__label">Max HR</span>
                <input
                  className="auth-input"
                  inputMode="numeric"
                  value={maxHr}
                  onChange={e => setMaxHr(e.target.value)}
                  onBlur={saveMaxHr}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  placeholder="e.g. 188"
                />
              </label>
            </div>
          </section>

          {/* 24 tiles is a third of a screen for a choice made once. The
              header carries the current pick, so folding it hides nothing. */}
          <ProfileDisclosure
            title="Avatar"
            status={currentAvatar?.label}
            thumb={currentAvatar && <img src={currentAvatar.src} alt="" />}
          >
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
          </ProfileDisclosure>

          <ProfileDisclosure title="Change password">
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
          </ProfileDisclosure>
        </div>

        <div className="profile-group">
          <h2 className="profile-group__title">AI</h2>

          <section className="profile-section">
            <h3 className="profile-section__title">Coach</h3>
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
          </section>

          {/* Set once at signup and then forgotten — but opened for you when
              there is no key, because without one the coach does nothing. */}
          <ProfileDisclosure
            title="Anthropic API key"
            status={keyStatus}
            defaultOpen={anthropicKey?.hasKey === false}
          >
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
                  Settings → API keys). Set Workspace to a specific workspace —
                  a key left on “same as personal account” will not work here —
                  and give it a long expiry, or the coach stops the day it
                  lapses. It's stored server-side and never shown in full again.
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
          </ProfileDisclosure>

          <McpTokens onShowGuide={() => setShowConnectorGuide(true)} />
        </div>

        <div className="profile-group">
          <h2 className="profile-group__title">Connections</h2>

          <CorosConnection />

          <ProfileDisclosure title="Calendar feed">
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
          </ProfileDisclosure>
        </div>

        {/* Last, and collapsed: a log is something you consult after the fact,
            never something you came here to change. */}
        <div className="profile-group">
          <h2 className="profile-group__title">Activity</h2>
          <CoachActivity />
        </div>

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
