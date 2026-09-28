import { useCallback, useEffect, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { Check, X } from 'lucide-react';
import {
  listCoachReflections, loadNotebookProfile, resolveCoachReflection, saveCoachContract, setReflectionOptIn,
} from '../../lib/api';
import { notify } from '../../lib/notify';
import {
  CONTRACT_MAX, diffLines, isNotAvailable, readNotebookProfile, readReflections, reflectionChangesContract,
  resolveInList, splitReflections, type CoachReflection, type NotebookProfile, type ReflectionResolution,
} from '../../lib/coach/notebook';

// The Contract tab: the coaching contract (profiles.coach_contract, lane D01)
// — the standing agreement between athlete and coach about how the coaching
// goes — editable and saved; the overnight reflections that propose edits to
// it, each a before/after card with Accept and Reject; and the switch that
// lets the coach reflect at all. Coded against D01's interface contract:
// until it merges GET /api/profile carries no coachContract, the handler
// answers 404 and the column 409 column-missing, all of which read as "not
// available yet" (src/lib/coach/notebook.ts) and render one calm banner —
// never an error, never a toast. Anything else that fails is a real failure
// and says so.
//
// The card is exported for the markup-level tests; the flows are proved in
// e2e/mock/coach-notebook.spec.ts.

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; profile: NotebookProfile };

export default function ContractTab() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [reflections, setReflections] = useState<CoachReflection[]>([]);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    let profilePayload: unknown;
    try {
      profilePayload = await loadNotebookProfile();
    } catch (err) {
      setPhase({ kind: isNotAvailable(err) ? 'unavailable' : 'failed' });
      return;
    }
    const profile = readNotebookProfile(profilePayload);
    if (!profile) {
      setPhase({ kind: 'unavailable' });
      return;
    }
    // The reflections are a second endpoint: it can be missing while the
    // column is there (or fail for its own reasons) without costing the
    // editor — the helper has already logged the warn.
    const list = await listCoachReflections().then(readReflections).catch(() => null);
    setReflections(list ?? []);
    setText(profile.coachContract);
    setSaved(profile.coachContract);
    setOptIn(profile.reflectionOptIn);
    setPhase({ kind: 'ready', profile });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const dirty = text !== saved;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSavedFlash(false);
    try {
      await saveCoachContract(text);
      setSaved(text);
      setSavedFlash(true);
    } catch (err) {
      if (isNotAvailable(err)) setPhase({ kind: 'unavailable' });
      else notify('Saving contract failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleOptIn = async (on: boolean) => {
    setOptIn(on);
    try {
      await setReflectionOptIn(on);
    } catch (err) {
      setOptIn(!on);
      if (isNotAvailable(err)) setPhase({ kind: 'unavailable' });
      else notify('Saving failed');
    }
  };

  const resolve = async (reflection: CoachReflection, resolution: ReflectionResolution) => {
    const before = reflections;
    setReflections(list => resolveInList(list, reflection.id, resolution, new Date().toISOString()));
    if (resolution === 'accepted') {
      // Accepting applies contract_after server-side; the editor follows,
      // unless the athlete is mid-edit — then the baseline moves and their
      // draft stays, so Save still means what it says.
      const after = reflection.contract_after ?? '';
      setSaved(after);
      if (!dirty) setText(after);
    }
    try {
      await resolveCoachReflection(reflection.id, resolution);
    } catch (err) {
      setReflections(before);
      if (isNotAvailable(err)) setPhase({ kind: 'unavailable' });
      else notify(resolution === 'accepted' ? 'Accepting the change failed' : 'Rejecting the change failed');
    }
  };

  if (phase.kind === 'loading') {
    return <p className="notebook-status" aria-busy="true">Reading the contract…</p>;
  }
  if (phase.kind === 'unavailable') {
    return (
      <div className="notebook-banner" role="status" data-testid="contract-unavailable">
        <p>
          The coaching contract isn't available yet. It arrives with the coach's overnight
          reflections; once it does, this is where you read it, edit it, and accept or reject
          what the coach proposes changing.
        </p>
      </div>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <div className="notebook-banner" role="status">
        <p>I couldn't read the contract just now.</p>
        <button type="button" className="btn-today" onClick={() => { void load(); }}>Try again</button>
      </div>
    );
  }

  const { pending, resolved } = splitReflections(reflections);

  return (
    <div className="notebook-contract-tab">
      {pending.length > 0 && (
        <section className="notebook-section" data-testid="contract-proposals">
          <h3 className="profile-section__title">Proposed changes</h3>
          <p className="profile-hint">
            After looking back over a day I sometimes want to change how I coach you. Each of
            these is a proposal; the contract changes only when you accept it.
          </p>
          <ul className="notebook-list">
            {pending.map(r => (
              <li key={r.id}>
                <ReflectionCard reflection={r} onResolve={resolution => { void resolve(r, resolution); }} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="notebook-section" data-testid="contract-editor">
        <h3 className="profile-section__title">The contract</h3>
        <p className="profile-hint">
          How we work together: what you want from me, what I'll push on, what I'll leave
          alone. Written in your words or mine — you have the last one.
        </p>
        <textarea
          className="auth-input auth-input--textarea notebook-contract"
          value={text}
          onChange={e => { setText(e.target.value); setSavedFlash(false); }}
          maxLength={CONTRACT_MAX}
          rows={8}
          placeholder="Push me on consistency, not volume. Never program through knee pain. Ask before moving a long day."
          aria-label="Coaching contract"
        />
        <div className="notebook-form__row">
          <button
            type="button"
            className="btn-today notebook-btn--primary"
            data-testid="contract-save"
            disabled={!dirty || saving}
            onClick={() => { void save(); }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedFlash && !dirty && <span className="notebook-saved" role="status">Saved</span>}
          <span className="notebook-count" aria-live="polite">{text.length} / {CONTRACT_MAX}</span>
        </div>
      </section>

      <section className="notebook-section">
        <h3 className="profile-section__title">Overnight reflection</h3>
        <label className="notebook-toggle">
          <input
            type="checkbox"
            checked={optIn}
            data-testid="reflection-opt-in"
            onChange={e => { void toggleOptIn(e.target.checked); }}
          />
          <span>
            Let me look back over each day and propose changes here — to the contract, and
            to what I remember. Proposals only; nothing changes without you.
          </span>
        </label>
      </section>

      {resolved.length > 0 && (
        <details className="notebook-history" data-testid="contract-history">
          <summary>Past reflections ({resolved.length})</summary>
          <ul className="notebook-list notebook-history__list">
            {resolved.map(r => (
              <li key={r.id} className="notebook-history__row">
                <span>{dayLabel(r.day)}</span>
                <span className="notebook-chip">{r.resolution ?? r.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** "Monday 7 September" for a YYYY-MM-DD day; the raw string if it is not one. */
function dayLabel(day: string): string {
  const parsed = parseISO(day);
  return isValid(parsed) ? format(parsed, 'EEEE d MMMM') : day;
}

/**
 * One pending reflection: the day, the coach's reason, the contract before
 * and after with changed lines marked (no diff dependency — a line LCS in
 * notebook.ts), a note when it also proposes memories, Accept and Reject.
 */
export function ReflectionCard({
  reflection, onResolve,
}: { reflection: CoachReflection; onResolve: (resolution: ReflectionResolution) => void }) {
  const changes = reflectionChangesContract(reflection);
  const diff = changes ? diffLines(reflection.contract_before ?? '', reflection.contract_after ?? '') : null;
  const proposals = reflection.memory_proposal_ids?.length ?? 0;
  return (
    <article className="notebook-card notebook-card--proposal" data-testid="reflection-card" data-reflection-id={reflection.id}>
      <p className="notebook-card__meta">
        <span className="notebook-chip">{dayLabel(reflection.day)}</span>
      </p>
      {reflection.reason && <p className="notebook-card__text">{reflection.reason}</p>}
      {diff && (
        <div className="notebook-diff" data-testid="reflection-diff">
          <DiffBlock label="Before" lines={diff.before} side="before" />
          <DiffBlock label="After" lines={diff.after} side="after" />
        </div>
      )}
      {proposals > 0 && (
        <p className="notebook-card__meta">
          Also proposes {proposals === 1 ? 'one memory' : `${proposals} memories`} — waiting in the Memory tab.
        </p>
      )}
      <div className="notebook-actions">
        <button type="button" className="btn-today notebook-btn--primary" data-testid="reflection-accept" onClick={() => onResolve('accepted')}>
          <Check size={14} strokeWidth={2} /> Accept
        </button>
        <button type="button" className="btn-today" data-testid="reflection-reject" onClick={() => onResolve('rejected')}>
          <X size={14} strokeWidth={1.5} /> Reject
        </button>
      </div>
    </article>
  );
}

function DiffBlock({
  label, lines, side,
}: { label: string; lines: Array<{ text: string; changed: boolean }>; side: 'before' | 'after' }) {
  return (
    <div className={`notebook-diff__block notebook-diff__block--${side}`}>
      <span className="notebook-diff__label">{label}</span>
      {lines.length === 0
        ? <span className="notebook-diff__line notebook-diff__line--empty">(empty)</span>
        : lines.map((line, i) => (
          <span key={i} className={`notebook-diff__line${line.changed ? ' notebook-diff__line--changed' : ''}`}>
            {line.text === '' ? ' ' : line.text}
          </span>
        ))}
    </div>
  );
}
