import { useRef, useState, useMemo, useEffect } from 'react';
import { useSchedule } from '../../context/ScheduleContext';
import { useCalendar } from '../../context/CalendarContext';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../hooks/useChat';
import { buildSystemPrompt } from '../../lib/coach/prompt';
import { findCoachTool } from '../../lib/coach/tools';
import { Send, Square, NotebookPen, Check, X, KeyRound } from 'lucide-react';

// ─── Confirmation card ────────────────────────────────────────────────────────

interface ConfirmCardProps {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}

function ConfirmCard({ label, onConfirm, onCancel, disabled }: ConfirmCardProps) {
  return (
    <div className="chat-confirm-card">
      <p className="chat-confirm-card__label">{label}</p>
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
    events, definitions, getEventsForDate,
    createEvent, updateEvent, deleteEvent, deleteEventInstance, rescheduleEvent,
    createDefinition, updateDefinition,
  } = useSchedule();
  const {
    messages, isLoading, streamingContent,
    pendingAction, sendMessage, confirmAction, cancelAction, triggerInitial, abort,
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

  const today = useMemo(() => new Date(), []);
  const todayEvents = useMemo(() => getEventsForDate(today), [getEventsForDate, today]);
  const systemPrompt = useMemo(
    () => buildSystemPrompt(todayEvents, events, today, definitions.values()),
    [todayEvents, events, today, definitions],
  );

  const isEmpty = messages.length === 0 && !isLoading && !pendingAction;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, pendingAction]);

  // ── Mutation executor (called on Confirm) — dispatches to the registry ─────

  const buildExecutor = () => async (): Promise<string> => {
    if (!pendingAction) return 'No action.';
    const tool = findCoachTool(pendingAction.toolName);
    if (!tool) return 'Unknown action.';
    return tool.execute(pendingAction.input, {
      createEvent, updateEvent, deleteEvent, deleteEventInstance, rescheduleEvent,
      definitions, createDefinition, updateDefinition,
    });
  };

  // Recompute the confirmation label with live app state — the stored label
  // (built at stream time in useChat, without context) is the fallback.
  const pendingLabel = pendingAction
    ? findCoachTool(pendingAction.toolName)?.displayLabel(pendingAction.input, { definitions, events })
      ?? pendingAction.displayLabel
    : '';

  // ── Input handlers ─────────────────────────────────────────────────────────

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || pendingAction) return;
    setInput('');
    sendMessage(text, systemPrompt);
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
    <div className="chat-sidebar">
      <div className="chat-sidebar__header">
        <span className="chat-sidebar__title">Coach</span>
        <span className="chat-sidebar__model">claude opus</span>
      </div>

      <div className="chat-sidebar__messages">
        {isEmpty && (
          <div className="chat-empty">
            {needsKey ? (
              <>
                <p className="chat-empty__hint">
                  The coach runs on your own Anthropic API key. Add one to
                  unlock chat and post-workout summaries.
                </p>
                <button
                  className="chat-key-setup-btn"
                  onClick={() => dispatch({ type: 'OPEN_PROFILE' })}
                >
                  <KeyRound size={13} />
                  Add API key
                </button>
              </>
            ) : (
              <p className="chat-empty__hint">Ask anything, or get your daily briefing below.</p>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg--${msg.role}`}>
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
            disabled={isLoading}
            onConfirm={() => confirmAction(buildExecutor(), systemPrompt)}
            onCancel={() => cancelAction(systemPrompt)}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-sidebar__actions">
        <button
          className="chat-notes-btn"
          onClick={() => triggerInitial(systemPrompt)}
          disabled={isLoading || !!pendingAction || needsKey}
        >
          <NotebookPen size={13} />
          Coach's Notes
        </button>
      </div>

      <div className="chat-sidebar__input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            needsKey ? 'Add your API key to chat…'
            : pendingAction ? 'Confirm or cancel above first…'
            : 'Ask your coach…'
          }
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isLoading || !!pendingAction || needsKey}
        />
        <button
          className="chat-send-btn"
          onClick={isLoading ? abort : handleSend}
          disabled={(!!pendingAction && !isLoading) || needsKey}
          aria-label={isLoading ? 'Stop' : 'Send'}
        >
          {isLoading ? <Square size={14} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
