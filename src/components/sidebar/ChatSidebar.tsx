import { useRef, useState, useMemo, useEffect, useCallback, type RefObject } from 'react';
import { useSchedule } from '../../context/schedule';
import { useMeals } from '../../context/meals';
import { useCalendar } from '../../context/calendar';
import { useAuth } from '../../context/auth';
import { format } from 'date-fns';
import { postJson } from '../../lib/api';
import { useChat } from '../../hooks/useChat';
import CoachModelPicker from '../coach/CoachModelPicker';
import { findCoachTool } from '../../lib/coach/tools';
import { previewForTool, type ToolPreview } from '../../lib/coach/preview';
import { useTip } from '../../hooks/useTip';
import { helpPath } from '../../lib/help/pages';
import { Send, Square, NotebookPen, Check, X, KeyRound, MessageSquarePlus } from 'lucide-react';
import { now } from '../../lib/clock';
import './confirm-preview.css';

// ─── On screen? ───────────────────────────────────────────────────────────────

/**
 * Whether `ref`'s element is laid out at all. The pane is always mounted
 * (AppShell), but CSS hides its column below 1025px unless the phone's Coach
 * tab is open — and a tip about a pane nobody can see would teach nothing.
 * A ResizeObserver fires on every display:none ↔ shown flip, so this follows
 * the tab without AppShell passing it down.
 */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOnScreen(el.getClientRects().length > 0);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

// ─── Confirmation card ────────────────────────────────────────────────────────

/** Field → before → after rows (update_event, update_exercise_definition). */
function ChangeRows({ changes }: { changes: Array<{ field: string; before: string; after: string }> }) {
  return (
    <dl className="confirm-preview__changes">
      {changes.map(c => (
        // A field appears once per input (the diff is keyed on input keys).
        <div key={c.field} style={{ display: 'contents' }}>
          <dt className="confirm-preview__field">{c.field}</dt>
          <dd className="confirm-preview__diff">
            <span className="confirm-preview__before">{c.before}</span>
            <span className="confirm-preview__arrow" aria-hidden="true">→</span>
            <span className="confirm-preview__after">{c.after}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExerciseList({ lines, tone }: { lines: string[]; tone: 'before' | 'after' }) {
  if (lines.length === 0) return <p className="confirm-preview__line confirm-preview__empty">No exercises</p>;
  return (
    <ul className={`confirm-preview__list confirm-preview__list--${tone}`}>
      {lines.map((line, i) => <li key={i}>{line}</li>)}
    </ul>
  );
}

/**
 * What the pending tool call will change, under the one-line label: the
 * structured preview from src/lib/coach/preview.ts. Renders nothing for a
 * null preview, so the card is exactly today's when there is nothing to show.
 */
function ConfirmPreview({ preview }: { preview: ToolPreview }) {
  switch (preview.kind) {
    case 'event-create': {
      const when = [preview.date, preview.time].filter(Boolean).join(' · ');
      const facts = [
        preview.durationMinutes !== undefined ? `${preview.durationMinutes} min` : null,
        preview.type ?? null,
      ].filter(Boolean).join(' · ');
      return (
        <div className="confirm-preview" data-testid="confirm-preview" data-kind={preview.kind}>
          <p className="confirm-preview__line"><strong>{when}</strong>{facts ? ` · ${facts}` : ''}</p>
          {preview.exercises.length > 0 && <ExerciseList lines={preview.exercises} tone="after" />}
        </div>
      );
    }
    case 'event-update':
    case 'definition-update':
      return (
        <div className="confirm-preview" data-testid="confirm-preview" data-kind={preview.kind}>
          <ChangeRows changes={preview.changes} />
        </div>
      );
    case 'event-delete':
      return (
        <div className="confirm-preview" data-testid="confirm-preview" data-kind={preview.kind}>
          <p className="confirm-preview__line">
            <strong>{preview.date}</strong>
            {preview.scope === 'series' && <span className="confirm-preview__scope--series"> · every occurrence in the series</span>}
            {preview.scope === 'one' && ' · this workout only'}
          </p>
        </div>
      );
    case 'exercises':
      return (
        <div className="confirm-preview" data-testid="confirm-preview" data-kind={preview.kind}>
          <p className="confirm-preview__heading">Before</p>
          <ExerciseList lines={preview.before} tone="before" />
          <p className="confirm-preview__heading">After</p>
          <ExerciseList lines={preview.after} tone="after" />
        </div>
      );
    case 'meal':
      return (
        <div className="confirm-preview" data-testid="confirm-preview" data-kind={`meal-${preview.action}`}>
          {preview.lines.map((line, i) => <p key={i} className="confirm-preview__line">{line}</p>)}
        </div>
      );
  }
}

interface ConfirmCardProps {
  label: string;
  /** Actions still queued behind this one (0 when it's the only one). */
  remaining: number;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
  /** The pane is visible, so a tip about this card can land on it. */
  onScreen: boolean;
  /** Structured before/after under the label; null renders the label alone. */
  preview?: ToolPreview | null;
}

function ConfirmCard({ label, remaining, onConfirm, onCancel, disabled, onScreen, preview = null }: ConfirmCardProps) {
  // First pending action ever: say that nothing happens until Confirm. The
  // card only mounts when the coach is waiting on the user, so this is the
  // moment by definition — conditioned, and held back only while the pane is
  // hidden (a phone on its Calendar tab while a turn finished).
  useTip('coach-confirm-card', onScreen);
  return (
    <div className="chat-confirm-card">
      <p className="chat-confirm-card__label">
        {label}
        {remaining > 0 && <span className="chat-confirm-card__queue"> · {remaining} more after this</span>}
      </p>
      {preview && <ConfirmPreview preview={preview} />}
      <div className="chat-confirm-card__actions">
        <button
          className="chat-confirm-card__btn chat-confirm-card__btn--cancel"
          onClick={onCancel}
          disabled={disabled}
        >
          <X size={12} /> Cancel
        </button>
        <button
          className="chat-confirm-card__btn chat-confirm-card__btn--confirm"
          onClick={onConfirm}
          disabled={disabled}
        >
          <Check size={12} /> Confirm
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ChatSidebar() {
  const {
    events, definitions, refreshCompletions,
  } = useSchedule();
  const { meals } = useMeals();
  const {
    messages, isLoading, streamingContent,
    pendingAction, pendingActionCount, sendMessage, confirmAction, cancelAction, triggerInitial,
    newThread, abort,
  } = useChat();
  const { dispatch } = useCalendar();
  const { anthropicKey } = useAuth();
  // Known-missing key blocks the coach with a setup prompt; unknown (null,
  // e.g. offline mode or status still loading) doesn't — the server's 402
  // mapping in useChat is the backstop.
  const needsKey = anthropicKey?.hasKey === false;

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);

  const today = useMemo(() => now(), []);

  // The server builds the system prompt from this user's own data (W5a);
  // the client only says which calendar day it is. Still resolved at call
  // time so the fake clock in e2e is read when a message is sent.
  const resolveContext = useCallback(async () => ({ today: format(today, 'yyyy-MM-dd') }), [today]);

  // Confirm/Cancel/Notes/Send all await resolveContext() (a network
  // round-trip) BEFORE useChat flips isLoading, so `disabled={isLoading}`
  // alone leaves a window where a double-click runs the executor twice —
  // duplicate backend mutations and a corrupted tool_result set. The ref is
  // the synchronous latch (state alone re-renders too late); the state
  // disables the buttons visually.
  const [actionBusy, setActionBusy] = useState(false);
  const actionLatchRef = useRef(false);
  const runExclusive = useCallback(async (fn: () => Promise<void>) => {
    if (actionLatchRef.current) return;
    actionLatchRef.current = true;
    setActionBusy(true);
    try {
      await fn();
    } finally {
      actionLatchRef.current = false;
      setActionBusy(false);
    }
  }, []);

  const isEmpty = messages.length === 0 && !isLoading && !pendingAction;

  // The coach's first-open tip: a key is saved (the no-key state has its own
  // setup copy) and the thread is empty, on a pane the user can see — the
  // desktop rail on load, a phone's Coach tab when it is opened. Nothing
  // autofocuses the input, so TipHost's typing hold does not stall it. A
  // stored thread that hydrates inside the 600 ms settle withdraws it.
  useTip('coach-first-message', onScreen && anthropicKey?.hasKey === true && isEmpty);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, pendingAction]);

  // ── Mutation executor (called on Confirm) — runs on the server ────────────
  // POST /api/coach-tool executes the confirmed tool with the same executors
  // this client used to run (W5b): the server stamps 'ai' attribution and
  // the audit log itself. Realtime reconciles events/definitions/meals; the
  // completion state of a retro-logged event is not subscribed, so refetch it.
  const buildExecutor = () => async (): Promise<string> => {
    if (!pendingAction) return 'No action.';
    const data = await postJson<{ resultText?: string }>('/api/coach-tool', {
      toolUseId: pendingAction.toolUseId,
      name: pendingAction.toolName,
      input: pendingAction.input,
      today: format(today, 'yyyy-MM-dd'),
    }, 'Applying coach action');
    refreshCompletions().catch(() => {});
    return data?.resultText ?? 'Done.';
  };

  // Recompute the confirmation label with live app state — the stored label
  // (built at stream time in useChat, without context) is the fallback.
  const pendingLabel = pendingAction
    ? findCoachTool(pendingAction.toolName)?.displayLabel(pendingAction.input, { definitions, events, meals })
      ?? pendingAction.displayLabel
    : '';

  // The before/after under the label, from the same live state. Memoized on
  // the action and the rows it reads: the pane re-renders on every keystroke
  // and streamed token, and the diff walks the event list.
  const pendingPreview = useMemo(
    () => (pendingAction
      ? previewForTool(pendingAction.toolName, pendingAction.input, { definitions, events, meals })
      : null),
    [pendingAction, definitions, events, meals],
  );

  // ── Input handlers ─────────────────────────────────────────────────────────

  const handleSend = () => {
    const text = input.trim();
    // The latch ref, not actionBusy: the state lags a render behind, and
    // clearing the input for a send runExclusive is about to drop would lose
    // the message with no error and nothing in the thread.
    if (!text || isLoading || actionLatchRef.current || pendingAction) return;
    setInput('');
    runExclusive(async () => sendMessage(text, await resolveContext()));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isStreaming = isLoading && streamingContent;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="chat-sidebar" ref={rootRef}>
      <div className="chat-sidebar__header">
        <span className="chat-sidebar__title">Coach</span>
        <CoachModelPicker />
      </div>

      <div className="chat-sidebar__messages">
        {isEmpty && (
          // A column when it holds the setup prompt: .chat-empty is a
          // centring row, which squeezed the button beside the hint. Inline,
          // like the actions row below, so this lane carries no app.css edit.
          <div className="chat-empty" style={needsKey ? { flexDirection: 'column' } : undefined}>
            {needsKey ? (
              <>
                <p className="chat-empty__hint">
                  The coach needs a key from Anthropic (a code). Add one to
                  turn on chat and workout summaries.
                </p>
                <button
                  className="chat-key-setup-btn"
                  onClick={() => dispatch({ type: 'OPEN_PROFILE' })}
                >
                  <KeyRound size={13} />
                  Add key
                </button>
                {/* Getting a key is the one step a new user cannot work out
                    alone; the help page walks it with pictures. */}
                <a
                  className="chat-empty__hint"
                  href={helpPath('get-api-key')}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginTop: 10, color: 'var(--text-secondary)', textDecoration: 'underline' }}
                >
                  How to get a key
                </a>
              </>
            ) : (
              <p className="chat-empty__hint">Ask anything, or get your daily briefing below.</p>
            )}
          </div>
        )}

        {/* Keyed on the message id, not the array index: a hydrated thread and
            a live one are the same list, and an index key would make React
            reuse a hydrated node for a newly streamed message. */}
        {messages.map(msg => (
          <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
            <p className="chat-msg__text">{msg.content}</p>
          </div>
        ))}

        {isStreaming && (
          <div className="chat-msg chat-msg--assistant">
            <p className="chat-msg__text">{streamingContent}<span className="chat-cursor" /></p>
          </div>
        )}

        {isLoading && !streamingContent && (
          <div className="chat-msg chat-msg--assistant">
            <span className="chat-typing"><span /><span /><span /></span>
          </div>
        )}

        {pendingAction && (
          <ConfirmCard
            label={pendingLabel}
            preview={pendingPreview}
            remaining={pendingActionCount - 1}
            disabled={isLoading || actionBusy}
            onScreen={onScreen}
            onConfirm={() => runExclusive(async () => confirmAction(buildExecutor(), await resolveContext()))}
            onCancel={() => runExclusive(async () => cancelAction(await resolveContext()))}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-sidebar__actions">
        {/* Two buttons in a row the stylesheet lays out as a block; the flex
            wrapper is inline so this PR carries no stylesheet change. */}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="chat-notes-btn"
            onClick={() => runExclusive(async () => triggerInitial(await resolveContext()))}
            disabled={isLoading || actionBusy || !!pendingAction || needsKey}
          >
            <NotebookPen size={13} />
            Coach's Notes
          </button>
          {/* The thread now survives a reload (D-013), so there has to be a
              way to leave one behind — but only once there is one: on an
              empty pane the button would replace an empty thread with an
              empty thread. Allowed without an API key; starting a thread
              asks nothing of Anthropic. */}
          {messages.length > 0 && (
            <button
              className="chat-notes-btn"
              onClick={() => runExclusive(async () => newThread())}
              disabled={isLoading || actionBusy || !!pendingAction}
            >
              <MessageSquarePlus size={13} />
              New thread
            </button>
          )}
        </div>
      </div>

      <div className="chat-sidebar__input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            needsKey ? 'Add your key to chat…'
            : pendingAction ? 'Confirm or cancel above first…'
            : 'Ask your coach…'
          }
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isLoading || actionBusy || !!pendingAction || needsKey}
        />
        <button
          className="chat-send-btn"
          onClick={isLoading ? abort : handleSend}
          disabled={(!isLoading && (actionBusy || !!pendingAction)) || needsKey}
          aria-label={isLoading ? 'Stop' : 'Send'}
        >
          {isLoading ? <Square size={14} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
