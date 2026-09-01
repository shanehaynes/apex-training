import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { KeyRound, Send, Sparkles, Square, X } from 'lucide-react';
import { useAuth } from '../../context/auth';
import { useCalendar } from '../../context/calendar';
import { useChat } from '../../hooks/useChat';
import { buildBuilderPrompt } from '../../lib/coach/prompt';
import CoachModelPicker from '../coach/CoachModelPicker';
import { applyDraftUpdate, describeDraft, type DraftUpdateInput, type WorkoutDraft } from '../../lib/builder/draft';
import { now } from '../../lib/clock';
import type { ExerciseDefinition, WorkoutTemplate } from '../../types/workout';

interface Props {
  draft: WorkoutDraft;
  setDraft: Dispatch<SetStateAction<WorkoutDraft>>;
  definitions: Map<string, ExerciseDefinition>;
  templates: Map<string, WorkoutTemplate>;
  onClose: () => void;
}

/**
 * The builder's embedded coach: a second, independent chat thread in
 * toolMode 'builder', whose single tool reduces onto the live draft
 * (applyDraftUpdate). Draft edits are auto-applied — no confirmation card:
 * the user's real gate is the Apply button, which only they can press, and
 * nothing here persists anything. The calendar/meal tools don't exist in
 * this mode, so the coach cannot touch anything beyond the form.
 */
export default function BuilderCoachPanel({ draft, setDraft, definitions, templates, onClose }: Props) {
  const {
    messages, isLoading, streamingContent,
    pendingAction, sendMessage, confirmAction, cancelAction, abort,
  } = useChat({ toolMode: 'builder' });
  const { dispatch } = useCalendar();
  const { anthropicKey } = useAuth();
  const needsKey = anthropicKey?.hasKey === false;

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // The prompt and the executor both need the draft AS OF NOW, not as of the
  // render that created a callback — the coach may queue several updates in
  // one response, each reducing onto the previous result.
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const today = useMemo(() => now(), []);
  const resolvePrompt = useCallback(() => buildBuilderPrompt(
    describeDraft(draftRef.current),
    [...templates.values()].filter(t => !t.archivedAt).map(t => t.title),
    definitions.values(),
    today,
  ), [templates, definitions, today]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // ── Auto-apply queued draft updates ────────────────────────────────────────
  // One action at a time; the settled ref stops the effect re-firing for an
  // action already being executed (confirmAction is async and re-renders).
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingAction || settledRef.current === pendingAction.toolUseId) return;
    settledRef.current = pendingAction.toolUseId;

    if (pendingAction.toolName !== 'update_workout_draft') {
      cancelAction(resolvePrompt());
      return;
    }
    confirmAction(async () => {
      const result = applyDraftUpdate(draftRef.current, pendingAction.input as DraftUpdateInput, definitions);
      if ('error' in result) return result.error;
      setDraft(result.draft);
      draftRef.current = result.draft;
      return result.summary;
    }, resolvePrompt());
  }, [pendingAction, confirmAction, cancelAction, resolvePrompt, definitions, setDraft]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || pendingAction) return;
    setInput('');
    sendMessage(text, resolvePrompt());
  };

  const isStreaming = isLoading && streamingContent;

  return (
    <div className="builder-coach">
      <div className="chat-sidebar__header builder-coach__header">
        <span className="chat-sidebar__title"><Sparkles size={14} strokeWidth={1.5} /> Coach</span>
        <CoachModelPicker />
        <button className="library-close builder-coach__close" onClick={onClose} aria-label="Hide coach">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="chat-sidebar__messages">
        {messages.length === 0 && !isLoading && (
          <div className="chat-empty">
            {needsKey ? (
              <>
                <p className="chat-empty__hint">
                  The coach runs on your own Anthropic API key. Add one to unlock it.
                </p>
                <button className="chat-key-setup-btn" onClick={() => dispatch({ type: 'OPEN_PROFILE' })}>
                  <KeyRound size={13} /> Add API key
                </button>
              </>
            ) : (
              <p className="chat-empty__hint">
                Describe the workout — the coach fills the form. Only you can press Apply.
              </p>
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

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-sidebar__input-row">
        <textarea
          className="chat-input"
          placeholder={needsKey ? 'Add your API key to chat…' : 'e.g. “Make this a 20 min AMRAP of…”'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          rows={1}
          disabled={isLoading || needsKey}
        />
        <button
          className="chat-send-btn"
          onClick={isLoading ? abort : handleSend}
          disabled={needsKey}
          aria-label={isLoading ? 'Stop' : 'Send'}
        >
          {isLoading ? <Square size={14} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}
