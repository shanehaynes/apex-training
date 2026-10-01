import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { KeyRound, Send, Sparkles, Square } from 'lucide-react';
import { format } from 'date-fns';
import { useAuth } from '../../context/auth';
import { useCalendar } from '../../context/calendar';
import { useChat } from '../../hooks/useChat';
import CoachModelPicker from '../coach/CoachModelPicker';
import { applyBlockDraftUpdate, type BlockDraft, type BlockDraftContext, type BlockDraftUpdateInput } from '../../lib/blocks/draft';
import '../sidebar/chat-reads.css';

interface Props {
  draft: BlockDraft;
  setDraft: Dispatch<SetStateAction<BlockDraft>>;
  /** The reducer's context: the athlete's blocks (overlap), objectives
   *  (objective_id) and the calendar date. */
  ctx: BlockDraftContext;
}

/**
 * The planner's coach thread (E01): a chat in toolMode 'planner', whose one
 * write, update_block_draft, reduces onto the block draft the user owns
 * (applyBlockDraftUpdate) — auto-applied, no confirmation card, because the
 * user's real gate is the Apply button, which only they can press. The read
 * tools and read_doctrine never reach this panel: api/chat.ts runs them
 * server-side and narrates them as the "Checked: …" chips rendered here.
 * Nothing here persists anything.
 */
export default function BlockPlannerPanel({ draft, setDraft, ctx }: Props) {
  const {
    messages, isLoading, streamingContent, streamingReads,
    pendingAction, sendMessage, confirmAction, cancelAction, abort,
  } = useChat({ toolMode: 'planner' });
  const { dispatch } = useCalendar();
  const { anthropicKey } = useAuth();
  const needsKey = anthropicKey?.hasKey === false;

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // The prompt and the reducer both need the draft AS OF NOW, not as of the
  // render that created a callback — the coach may queue several updates in
  // one response, each reducing onto the previous result. The context rides
  // in a ref for the same reason, and so the settle effect's deps stay put.
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const ctxRef = useRef(ctx);
  useEffect(() => { ctxRef.current = ctx; }, [ctx]);

  // The server describes the draft, the athlete's blocks and objectives in
  // the prompt (context.ts, planner branch); the client sends the draft as of now.
  const resolvePrompt = useCallback(
    () => ({ today: format(ctxRef.current.today, 'yyyy-MM-dd'), draft: draftRef.current }),
    [],
  );

  // Follow the thread as it grows: a new message, a streamed delta, a chip.
  useEffect(() => {
    if (messages.length === 0 && !streamingContent && streamingReads.length === 0) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingContent, streamingReads.length]);

  // ── Auto-apply queued draft updates (the builder panel's settle pattern) ──
  // One action at a time; the settled ref stops the effect re-firing for an
  // action already being executed (confirmAction is async and re-renders).
  // Anything that is not the draft tool is cancelled: the planner has no
  // other write, and the reads never arrive here.
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingAction || settledRef.current === pendingAction.toolUseId) return;
    settledRef.current = pendingAction.toolUseId;

    if (pendingAction.toolName !== 'update_block_draft') {
      cancelAction(resolvePrompt());
      return;
    }
    confirmAction(async () => {
      const result = applyBlockDraftUpdate(draftRef.current, pendingAction.input as BlockDraftUpdateInput, ctxRef.current);
      if ('error' in result) return result.error;
      setDraft(result.draft);
      draftRef.current = result.draft;
      return result.summary;
    }, resolvePrompt());
  }, [pendingAction, confirmAction, cancelAction, resolvePrompt, setDraft]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || pendingAction) return;
    setInput('');
    sendMessage(text, resolvePrompt());
  };

  const isStreaming = isLoading && streamingContent;

  return (
    <div className="block-planner__coach" data-testid="block-planner-coach">
      <div className="block-planner__coach-header">
        <span className="chat-sidebar__title"><Sparkles size={14} strokeWidth={1.5} /> Coach</span>
        <CoachModelPicker />
      </div>

      <div className="chat-sidebar__messages">
        {messages.length === 0 && !isLoading && (
          <div className="chat-empty">
            {needsKey ? (
              <>
                <p className="chat-empty__hint">
                  The coach needs a key from Anthropic (a code). Add one to turn it on.
                </p>
                <button className="chat-key-setup-btn" onClick={() => dispatch({ type: 'OPEN_PROFILE' })}>
                  <KeyRound size={13} /> Add key
                </button>
              </>
            ) : (
              <p className="chat-empty__hint">
                Say what you are training for and when. The coach reads your history and the doctrine, then drafts the blocks. Only you can press Apply.
              </p>
            )}
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
            {msg.reads && msg.reads.length > 0 && <ReadChips labels={msg.reads} />}
            <p className="chat-msg__text">{msg.content}</p>
          </div>
        ))}

        {isLoading && streamingReads.length > 0 && (
          <div className="chat-msg chat-msg--assistant">
            <ReadChips labels={streamingReads} streaming />
          </div>
        )}

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
          placeholder={needsKey ? 'Add your key to chat…' : 'e.g. “12 weeks to Denali, base to taper”'}
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

/** "Checked: …" — one chip per server-side call the coach made before (or
 *  while) it spoke, in the order it made them. Same markup and styles as the
 *  sidebar's (chat-reads.css); `streaming` marks the turn still in flight. */
export function ReadChips({ labels, streaming = false }: { labels: string[]; streaming?: boolean }) {
  return (
    <ul
      className={`chat-reads${streaming ? ' chat-reads--streaming' : ''}`}
      data-testid="chat-reads"
      aria-label="What the coach checked"
    >
      {labels.map((label, i) => (
        <li key={i} className="chat-reads__chip" title={label}>{label}</li>
      ))}
    </ul>
  );
}
