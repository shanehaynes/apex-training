import { useState, useCallback, useRef } from 'react';
import { ApiError, authHeaders } from '../lib/api';
import { findCoachTool } from '../lib/coach/tools';
import type { ChatWireEvent } from '../lib/coach/wire';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Matches what the Anthropic API accepts in the messages array — the shapes
// are forwarded verbatim by /api/chat.
type TextBlock    = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string };

type ApiMessage = {
  role: 'user';
  content: string | ToolResultBlock[];
} | {
  role: 'assistant';
  content: string | Array<TextBlock | ToolUseBlock>;
};

/** Shown when the server answers 402: the user has no Anthropic key saved. */
const KEY_SETUP_MESSAGE =
  'To use the coach, add your Anthropic API key under Profile → AI Coach (the circle avatar, top left).';

function isMissingKeyError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 402;
}

export interface PendingAction {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** One-liner shown in the confirmation card, e.g. "Delete: Upper Body · Mon Jun 29" */
  displayLabel: string;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useChat() {
  const [messages,       setMessages]       = useState<DisplayMessage[]>([]);
  const [apiMessages,    setApiMessages]    = useState<ApiMessage[]>([]);
  const [pendingAction,  setPendingAction]  = useState<PendingAction | null>(null);
  const [isLoading,      setIsLoading]      = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const abortRef = useRef<(() => void) | null>(null);

  // ── Core streaming helper — reads NDJSON wire events from /api/chat ───────

  async function streamResponse(
    msgs: ApiMessage[],
    systemPrompt: string,
    withTools: boolean,
  ): Promise<{ text: string; toolUse: ToolUseBlock | null }> {
    const controller = new AbortController();
    abortRef.current = () => controller.abort();

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ messages: msgs, system: systemPrompt, withTools }),
      signal: controller.signal,
    });
    // ApiError keeps the status so catches can tell "no API key saved"
    // (402) apart from a real failure. This fetch bypasses requestJson, so
    // no toast fires — chat errors render inline in the thread.
    if (!res.ok || !res.body) {
      throw new ApiError(await res.text().catch(() => `chat request failed: ${res.status}`), res.status);
    }

    let textAccumulated = '';
    let toolUse: ToolUseBlock | null = null;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as ChatWireEvent;
      if (event.type === 'text') {
        textAccumulated += event.delta;
        setStreamingContent(textAccumulated);
      } else if (event.type === 'tool_use') {
        toolUse = { type: 'tool_use', id: event.id, name: event.name, input: event.input };
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    handleLine(buffer);

    return { text: textAccumulated, toolUse };
  }

  // ── sendMessage ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (content: string, systemPrompt: string) => {
    setIsLoading(true);
    setStreamingContent('');

    const userDisplayMsg: DisplayMessage = { role: 'user', content };
    const userApiMsg: ApiMessage = { role: 'user', content };

    setMessages(prev => [...prev, userDisplayMsg]);

    const nextApiMessages: ApiMessage[] = [...apiMessages, userApiMsg];
    setApiMessages(nextApiMessages);

    try {
      const { text, toolUse } = await streamResponse(nextApiMessages, systemPrompt, true);

      // Build the assistant's API content (may include tool_use block)
      const assistantContent: Array<TextBlock | ToolUseBlock> = [];
      if (text)    assistantContent.push({ type: 'text', text });
      if (toolUse) assistantContent.push(toolUse);

      const assistantApiMsg: ApiMessage = {
        role:    'assistant',
        content: assistantContent.length === 1 && assistantContent[0].type === 'text'
          ? text   // simple string for pure-text responses
          : assistantContent,
      };

      const withAssistant = [...nextApiMessages, assistantApiMsg];
      setApiMessages(withAssistant);

      if (toolUse) {
        // Show any pre-tool text Claude spoke, then surface the pending action
        if (text) setMessages(prev => [...prev, { role: 'assistant', content: text }]);
        setPendingAction({
          toolUseId:    toolUse.id,
          toolName:     toolUse.name,
          input:        toolUse.input,
          displayLabel: findCoachTool(toolUse.name)?.displayLabel(toolUse.input) ?? toolUse.name,
        });
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: text }]);
      }
    } catch (err: unknown) {
      if (isMissingKeyError(err)) {
        setMessages(prev => [...prev, { role: 'assistant', content: KEY_SETUP_MESSAGE }]);
      } else if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I ran into an error. Please try again.' }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [apiMessages]);

  // ── confirmAction ──────────────────────────────────────────────────────────

  const confirmAction = useCallback(async (
    executor: () => Promise<string>,
    systemPrompt: string,
  ) => {
    if (!pendingAction) return;
    setIsLoading(true);
    setStreamingContent('');
    setPendingAction(null);

    let resultText = 'Done.';
    try {
      resultText = await executor();
    } catch {
      resultText = 'The operation failed — something went wrong on the backend.';
    }

    const toolResultMsg: ApiMessage = {
      role:    'user',
      content: [{ type: 'tool_result', tool_use_id: pendingAction.toolUseId, content: resultText }],
    };

    const withResult = [...apiMessages, toolResultMsg];
    setApiMessages(withResult);

    try {
      const { text } = await streamResponse(withResult, systemPrompt, false);
      setMessages(prev => [...prev, { role: 'assistant', content: text }]);
      setApiMessages(prev => [...prev, { role: 'assistant', content: text }]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Done — but I had trouble confirming. The change was applied.' }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [pendingAction, apiMessages]);

  // ── cancelAction ───────────────────────────────────────────────────────────

  const cancelAction = useCallback(async (systemPrompt: string) => {
    if (!pendingAction) return;
    setIsLoading(true);
    setStreamingContent('');
    setPendingAction(null);

    const toolResultMsg: ApiMessage = {
      role:    'user',
      content: [{ type: 'tool_result', tool_use_id: pendingAction.toolUseId, content: 'Cancelled by user.' }],
    };

    const withResult = [...apiMessages, toolResultMsg];
    setApiMessages(withResult);

    try {
      const { text } = await streamResponse(withResult, systemPrompt, false);
      setMessages(prev => [...prev, { role: 'assistant', content: text }]);
      setApiMessages(prev => [...prev, { role: 'assistant', content: text }]);
    } catch { /* silent */ } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [pendingAction, apiMessages]);

  // ── triggerInitial (Coach's Notes — no tools) ──────────────────────────────

  const triggerInitial = useCallback(async (systemPrompt: string) => {
    setIsLoading(true);
    setStreamingContent('');
    setPendingAction(null);

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
    pendingAction,
    sendMessage,
    confirmAction,
    cancelAction,
    triggerInitial,
    abort,
  };
}
