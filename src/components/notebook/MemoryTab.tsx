import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Plus, X } from 'lucide-react';
import {
  addCoachMemory, archiveCoachMemory, confirmCoachMemory, listCoachMemories,
} from '../../lib/api';
import {
  MEMORY_CONTENT_MAX, MEMORY_KIND_ORDER, memoryFileLabel, type CoachMemory, type MemoryKind,
} from '../../lib/coach/memory';
import {
  confirmInList, forgetInList, memorySourceLabel, messageOf, prependToList, restoreToList,
  splitMemories, statusOf, type MemoryKindGroup,
} from '../../lib/coach/notebook';

// The Memory tab: what the coach may remember about the athlete, over
// /api/coach-memory (lane C02). Proposals — rows a reflection or a
// conversation wrote that nobody has confirmed — sit on top with Accept and
// Forget, because they are the reason the athlete opened the page; the
// confirmed facts follow, grouped by kind in the prompt's order; the
// add-a-fact form closes the page. Every write is optimistic and undone if
// the server refuses it; the API helpers toast the failure, and a 409 (the
// 200-fact cap) is shown here in the server's own words, because "Confirming
// memory failed" would hide the one thing the athlete can do about it.
//
// The presentational pieces are exported for the markup-level tests: this
// repo has no DOM test environment, so the click flow — pending → accept →
// confirmed — is proved in e2e/mock/coach-notebook.spec.ts.

type Load = 'loading' | 'failed' | 'ready';

export default function MemoryTab() {
  const [memories, setMemories] = useState<CoachMemory[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoad('loading');
    try {
      const payload = await listCoachMemories();
      setMemories(Array.isArray(payload?.memories) ? payload.memories : []);
      setLoad('ready');
    } catch {
      setLoad('failed');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const accept = async (memory: CoachMemory) => {
    setNotice(null);
    setMemories(list => confirmInList(list, memory.id, new Date().toISOString()));
    try {
      const { memory: saved } = await confirmCoachMemory(memory.id);
      if (saved) setMemories(list => list.map(m => (m.id === saved.id ? saved : m)));
    } catch (err) {
      setMemories(list => restoreToList(list, memory));
      if (statusOf(err) === 409) setNotice(messageOf(err, 'Memory is full — forget one first'));
    }
  };

  const forget = async (memory: CoachMemory) => {
    setNotice(null);
    setMemories(list => forgetInList(list, memory.id));
    try {
      await archiveCoachMemory(memory.id);
    } catch {
      setMemories(list => restoreToList(list, memory));
    }
  };

  const add = async (kind: MemoryKind, content: string): Promise<boolean> => {
    setNotice(null);
    try {
      const { memory } = await addCoachMemory(kind, content);
      if (memory) setMemories(list => prependToList(list, memory));
      return true;
    } catch (err) {
      if (statusOf(err) === 409) setNotice(messageOf(err, 'Memory is full — forget one first'));
      return false;
    }
  };

  if (load === 'loading') {
    return <p className="notebook-status" aria-busy="true">Reading what I hold about you…</p>;
  }
  if (load === 'failed') {
    return (
      <div className="notebook-banner" role="status">
        <p>I couldn't reach my memory just now.</p>
        <button type="button" className="btn-today" onClick={() => { void reload(); }}>Try again</button>
      </div>
    );
  }

  const { proposals, confirmed } = splitMemories(memories);

  return (
    <div className="notebook-memory-tab">
      {proposals.length > 0 && (
        <section className="notebook-section" data-testid="memory-proposals">
          <h3 className="profile-section__title">Waiting on you</h3>
          <p className="profile-hint">
            I'd like to remember these. Nothing is kept until you say so.
          </p>
          {notice && <p className="auth-error notebook-notice" role="alert">{notice}</p>}
          <ul className="notebook-list">
            {proposals.map(m => (
              <li key={m.id}>
                <ProposalCard memory={m} onAccept={() => { void accept(m); }} onForget={() => { void forget(m); }} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="notebook-section" data-testid="memory-confirmed">
        <h3 className="profile-section__title">What I remember</h3>
        {confirmed.length === 0
          ? <MemoryEmpty proposed={proposals.length > 0} />
          : <MemoryGroups groups={confirmed} onForget={m => { void forget(m); }} />}
      </section>

      <section className="notebook-section">
        <h3 className="profile-section__title">Tell me something to keep</h3>
        {notice && proposals.length === 0 && <p className="auth-error notebook-notice" role="alert">{notice}</p>}
        <AddMemoryForm onAdd={add} />
      </section>
    </div>
  );
}

/** One proposed memory: the fact, where it came from, Accept and Forget. */
export function ProposalCard({
  memory, onAccept, onForget,
}: { memory: CoachMemory; onAccept: () => void; onForget: () => void }) {
  const source = memorySourceLabel(memory.source_kind);
  return (
    <article className="notebook-card notebook-card--proposal" data-testid="memory-proposal" data-kind={memory.kind}>
      <p className="notebook-card__text">{memory.content}</p>
      <p className="notebook-card__meta">
        <span className="notebook-chip">{memoryFileLabel(memory.kind)}</span>
        {source && <span> · {source}</span>}
      </p>
      <div className="notebook-actions">
        <button type="button" className="btn-today notebook-btn--primary" data-testid="memory-accept" onClick={onAccept}>
          <Check size={14} strokeWidth={2} /> Accept
        </button>
        <button type="button" className="btn-today" data-testid="memory-forget" onClick={onForget}>
          Forget
        </button>
      </div>
    </article>
  );
}

/** The confirmed facts, one group per kind that has any, each row with a Forget. */
export function MemoryGroups({
  groups, onForget,
}: { groups: MemoryKindGroup[]; onForget: (memory: CoachMemory) => void }) {
  return (
    <div className="notebook-groups">
      {groups.map(group => (
        <section key={group.kind} className="notebook-group" data-testid={`memory-group-${group.kind}`}>
          <h4 className="notebook-group__title">{group.label}</h4>
          <ul className="notebook-list">
            {group.memories.map(m => (
              <li key={m.id} className="notebook-memory" data-testid="memory-row">
                <span className="notebook-memory__text">{m.content}</span>
                <button
                  type="button"
                  className="notebook-memory__forget"
                  aria-label="Forget this"
                  title="Forget this"
                  onClick={() => onForget(m)}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Nothing confirmed yet — in the coach's voice, because the coach is who is speaking here. */
export function MemoryEmpty({ proposed }: { proposed: boolean }) {
  return (
    <p className="notebook-empty" data-testid="memory-empty">
      {proposed
        ? 'Nothing confirmed yet — the facts above are waiting on you.'
        : "I don't hold anything about you yet. Tell me what to keep — an injury to work around, " +
          'a goal with a date on it, how you like to train — or confirm what I propose after we talk.'}
    </p>
  );
}

/** Kind + text, ≤ 500 characters; the coach keeps it as confirmed on arrival. */
export function AddMemoryForm({
  onAdd, initialKind = 'note',
}: { onAdd: (kind: MemoryKind, content: string) => Promise<boolean>; initialKind?: MemoryKind }) {
  const [kind, setKind] = useState<MemoryKind>(initialKind);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const content = text.replace(/\s+/g, ' ').trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!content || busy) return;
    setBusy(true);
    const ok = await onAdd(kind, content);
    setBusy(false);
    if (ok) setText('');
  };

  return (
    <form className="notebook-form" onSubmit={e => { void submit(e); }} data-testid="memory-add">
      <div className="notebook-form__row">
        <label className="notebook-form__field">
          <span className="auth-field__label">Kind</span>
          <select
            className="auth-input notebook-select"
            value={kind}
            onChange={e => setKind(e.target.value as MemoryKind)}
            aria-label="Kind of fact"
          >
            {MEMORY_KIND_ORDER.map(k => (
              <option key={k} value={k}>{memoryFileLabel(k)}</option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        className="auth-input auth-input--textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        maxLength={MEMORY_CONTENT_MAX}
        rows={2}
        placeholder="Left knee: no deep squats until the physio clears it"
        aria-label="The fact to remember"
      />
      <div className="notebook-form__row">
        <button type="submit" className="btn-today notebook-btn--primary" disabled={!content || busy}>
          <Plus size={14} strokeWidth={2} /> {busy ? 'Keeping…' : 'Keep this'}
        </button>
        <span className="notebook-count" aria-live="polite">{content.length} / {MEMORY_CONTENT_MAX}</span>
      </div>
    </form>
  );
}
