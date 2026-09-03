import { useState, useCallback, useRef } from 'react';
import { useAuth } from '../context/auth';
import { ApiError, authHeaders } from '../lib/api';
import { createWireCollector } from '../lib/coach/wire';
import { toPendingActions, settleHead, appendUserText } from '../lib/coach/actionQueue';
import type { ApiMessage, PendingAction, TextBlock, ToolResultBlock } from '../lib/coach/actionQueue';
import type { WireToolUse } from '../lib/coach/wire';

export type { PendingAction } from '../lib/coach/actionQueue';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Shown when the server answers 402: the user has no Anthropic key saved. */
const KEY_SETUP_MESSAGE =
  'To use the coach, add your Anthropic API key under Profile → AI Coach (the circle avatar, top left).';

/** Shown when the server answers 429: the per-user chat rate limit tripped. */
const RATE_LIMIT_MESSAGE =
  'The coach is taking a breather — too many requests in a short window. Try again in a few minutes.';

function isMissingKeyError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 402;
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseChatOptions {
  /** 'builder' scopes the server's tool list to update_workout_draft. */
  toolMode?: 'chat' | 'builder' | 'analytics';
}

/**
 * What the server needs to build the system prompt for a turn (W5a): the
 * caller's local calendar date, and — for the builder/analytics coaches —
 * the draft as of now. The server assembles the prompt from the caller's own
 * data, so the client never ships schedule text.
 */
export interface ChatContext {
  /** YYYY-MM-DD in the device's local calendar. */
  today: string;
  /** builder: WorkoutDraft · analytics: ChartDraft · chat: absent. */
  draft?: unknown;
}

export function useChat({ toolMode }: UseChatOptions = {}) {
  // Read here rather than as a prop: all three coach panels get the user's
  // model pick for free, and none of them has to thread it through.
  // undefined/null just means "server picks the default" — see models.ts.
  const { profile } = useAuth();
  const [messages,       setMessages]       = useState<DisplayMessage[]>([]);
  const [apiMessages,    setApiMessages]    = useState<ApiMessage[]>([]);
  // A response may carry several tool_use blocks — each is confirmed or
  // cancelled in turn, and the results are held until the queue drains
  // (the API requires a tool_result for every tool_use before the coach
  // can speak again). See src/lib/coach/actionQueue.ts.
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [heldResults,    setHeldResults]    = useState<ToolResultBlock[]>([]);
  const [isLoading,      setIsLoading]      = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const abortRef = useRef<(() => void) | null>(null);
  // Carried in every callback's dep list below, not just closed over: these
  // are memoized on other state, so a switch in the picker with no other
  // change would otherwise keep sending the previous model.
  const coachModel = profile?.coach_model ?? undefined;

  // ── Core streaming helper — reads NDJSON wire events from /api/chat ───────

  async function streamResponse(
    msgs: ApiMessage[],
    ctx: ChatContext,
    withTools: boolean,
  ): Promise<{ text: string; toolUses: WireToolUse[] }> {
    const controller = new AbortController();
    abortRef.current = () => controller.abort();

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        mode: toolMode ?? 'chat',
        messages: msgs,
        withTools,
        today: ctx.today,
        ...(ctx.draft !== undefined ? { context: { draft: ctx.draft } } : {}),
        ...(coachModel ? { model: coachModel } : {}),
      }),
      signal: controller.signal,
    });
    // ApiError keeps the status so catches can tell "no API key saved"
    // (402) apart from a real failure. This fetch bypasses requestJson, so
    // no toast fires — chat errors render inline in the thread.
    if (!res.ok || !res.body) {
      throw new ApiError(await res.text().catch(() => `chat request failed: ${res.status}`), res.status);
    }

    const collector = createWireCollector(setStreamingContent);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(decoder.decode(value, { stream: true }));
    }
    collector.end();

    return { text: collector.text, toolUses: collector.toolUses };
  }

  // ── sendMessage ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (content: string, ctx: ChatContext) => {
    setIsLoading(true);
    setStreamingContent('');

    const userDisplayMsg: DisplayMessage = { role: 'user', content };

    setMessages(prev => [...prev, userDisplayMsg]);

    // appendUserText folds the text into a trailing unanswered tool_result
    // message if the last flush stream failed — see actionQueue.ts.
    const nextApiMessages = appendUserText(apiMessages, content);
    setApiMessages(nextApiMessages);

    try {
      const { text, toolUses } = await streamResponse(nextApiMessages, ctx, true);

      // Build the assistant's API content (may include tool_use blocks)
      const assistantContent: Array<TextBlock | WireToolUse> = [];
      if (text) assistantContent.push({ type: 'text', text });
      assistantContent.push(...toolUses);

      const assistantApiMsg: ApiMessage = {
        role:    'assistant',
        content: assistantContent.length === 1 && assistantContent[0].type === 'text'
          ? text   // simple string for pure-text responses
          : assistantContent,
      };

      const withAssistant = [...nextApiMessages, assistantApiMsg];
      setApiMessages(withAssistant);

      if (toolUses.length > 0) {
        // Show any pre-tool text Claude spoke, then surface the pending
        // actions — one confirmation card at a time, in emission order
        if (text) setMessages(prev => [...prev, { role: 'assistant', content: text }]);
        setHeldResults([]);
        setPendingActions(toPendingActions(toolUses));
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: text }]);
      }
    } catch (err: unknown) {
      if (isMissingKeyError(err)) {
        setMessages(prev => [...prev, { role: 'assistant', content: KEY_SETUP_MESSAGE }]);
      } else if (isRateLimitError(err)) {
        setMessages(prev => [...prev, { role: 'assistant', content: RATE_LIMIT_MESSAGE }]);
      } else if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I ran into an error. Please try again.' }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [apiMessages, coachModel]);

  // ── settleAction — shared confirm/cancel step ──────────────────────────────

  // Settles the head action with its tool_result text. While actions remain,
  // just advance the queue (the next confirmation card appears). Once the
  // last settles, send every held result as ONE user message and stream the
  // coach's tools-off follow-up.
  const settleAction = useCallback(async (
    resultText: string,
    ctx: ChatContext,
    failureMessage: string,
  ) => {
    const { queue, results, flushed } = settleHead(pendingActions, heldResults, resultText);
    setPendingActions(queue);
    setHeldResults(results);
    if (!flushed) return;

    setIsLoading(true);
    setStreamingContent('');

    const toolResultMsg: ApiMessage = { role: 'user', content: flushed };
    const withResult = [...apiMessages, toolResultMsg];
    setApiMessages(withResult);

    try {
      const { text } = await streamResponse(withResult, ctx, false);
      setMessages(prev => [...prev, { role: 'assistant', content: text }]);
      setApiMessages(prev => [...prev, { role: 'assistant', content: text }]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError' && failureMessage) {
        setMessages(prev => [...prev, { role: 'assistant', content: failureMessage }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [pendingActions, heldResults, apiMessages, coachModel]);

  // ── confirmAction ──────────────────────────────────────────────────────────

  const confirmAction = useCallback(async (
    executor: () => Promise<string>,
    ctx: ChatContext,
  ) => {
    if (pendingActions.length === 0) return;
    setIsLoading(true);

    let resultText = 'Done.';
    try {
      resultText = await executor();
    } catch {
      resultText = 'The operation failed — something went wrong on the backend.';
    } finally {
      setIsLoading(false);
    }

    await settleAction(resultText, ctx, 'Done — but I had trouble confirming. The change was applied.');
  }, [pendingActions, settleAction]);

  // ── cancelAction ───────────────────────────────────────────────────────────

  const cancelAction = useCallback(async (ctx: ChatContext) => {
    if (pendingActions.length === 0) return;
    await settleAction('Cancelled by user.', ctx, '');
  }, [pendingActions, settleAction]);

  // ── triggerInitial (Coach's Notes — no tools) ──────────────────────────────

  const triggerInitial = useCallback(async (ctx: ChatContext) => {
    setIsLoading(true);
    setStreamingContent('');
    setPendingActions([]);
    setHeldResults([]);

    const syntheticUser: ApiMessage = { role: 'user', content: 'Give me my coaching briefing for today.' };

    try {
      const { text } = await streamResponse([syntheticUser], ctx, false);
      const assistantMsg: ApiMessage = { role: 'assistant', content: text };
      // Seed apiMessages so follow-up chat has valid history
      setApiMessages([syntheticUser, assistantMsg]);
      setMessages([{ role: 'assistant', content: text }]);
    } catch (err: unknown) {
      if (isMissingKeyError(err)) {
        setMessages([{ role: 'assistant', content: KEY_SETUP_MESSAGE }]);
      } else if (isRateLimitError(err)) {
        setMessages([{ role: 'assistant', content: RATE_LIMIT_MESSAGE }]);
      } else if (err instanceof Error && err.name !== 'AbortError') {
        setMessages([{ role: 'assistant', content: "Couldn't reach the coaching server. Please try again." }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [coachModel]);

  const abort = useCallback(() => { abortRef.current?.(); }, []);

  return {
    messages,
    isLoading,
    streamingContent,
    /** Head of the queue — the action currently awaiting confirm/cancel. */
    pendingAction: pendingActions[0] ?? null,
    /** How many actions remain (including the one showing), for "1 of N" UI. */
    pendingActionCount: pendingActions.length,
    sendMessage,
    confirmAction,
    cancelAction,
    triggerInitial,
    abort,
  };
}
