import { useState, useCallback, useRef } from 'react';
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
  toolMode?: 'chat' | 'builder';
}

export function useChat({ toolMode }: UseChatOptions = {}) {
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

  // ── Core streaming helper — reads NDJSON wire events from /api/chat ───────

  async function streamResponse(
    msgs: ApiMessage[],
    systemPrompt: string,
    withTools: boolean,
  ): Promise<{ text: string; toolUses: WireToolUse[] }> {
    const controller = new AbortController();
    abortRef.current = () => controller.abort();

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ messages: msgs, system: systemPrompt, withTools, ...(toolMode ? { toolMode } : {}) }),
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

  const sendMessage = useCallback(async (content: string, systemPrompt: string) => {
    setIsLoading(true);
    setStreamingContent('');

    const userDisplayMsg: DisplayMessage = { role: 'user', content };

    setMessages(prev => [...prev, userDisplayMsg]);

    // appendUserText folds the text into a trailing unanswered tool_result
    // message if the last flush stream failed — see actionQueue.ts.
    const nextApiMessages = appendUserText(apiMessages, content);
    setApiMessages(nextApiMessages);

    try {
      const { text, toolUses } = await streamResponse(nextApiMessages, systemPrompt, true);

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
  }, [apiMessages]);

  // ── settleAction — shared confirm/cancel step ──────────────────────────────

  // Settles the head action with its tool_result text. While actions remain,
  // just advance the queue (the next confirmation card appears). Once the
  // last settles, send every held result as ONE user message and stream the
  // coach's tools-off follow-up.
  const settleAction = useCallback(async (
    resultText: string,
    systemPrompt: string,
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
      const { text } = await streamResponse(withResult, systemPrompt, false);
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
  }, [pendingActions, heldResults, apiMessages]);

  // ── confirmAction ──────────────────────────────────────────────────────────

  const confirmAction = useCallback(async (
    executor: () => Promise<string>,
    systemPrompt: string,
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

    await settleAction(resultText, systemPrompt, 'Done — but I had trouble confirming. The change was applied.');
  }, [pendingActions, settleAction]);

  // ── cancelAction ───────────────────────────────────────────────────────────

  const cancelAction = useCallback(async (systemPrompt: string) => {
    if (pendingActions.length === 0) return;
    await settleAction('Cancelled by user.', systemPrompt, '');
  }, [pendingActions, settleAction]);

  // ── triggerInitial (Coach's Notes — no tools) ──────────────────────────────

  const triggerInitial = useCallback(async (systemPrompt: string) => {
    setIsLoading(true);
    setStreamingContent('');
    setPendingActions([]);
    setHeldResults([]);

    const syntheticUser: ApiMessage = { role: 'user', content: 'Give me my coaching briefing for today.' };

    try {
      const { text } = await streamResponse([syntheticUser], systemPrompt, false);
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
  }, []);

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
