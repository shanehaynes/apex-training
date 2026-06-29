import { useState, useCallback, useRef } from 'react';
import Anthropic from '@anthropic-ai/sdk';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Matches what the Anthropic API actually accepts in the messages array.
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

export interface PendingAction {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** One-liner shown in the confirmation card, e.g. "Delete: Upper Body · Mon Jun 29" */
  displayLabel: string;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'delete_event',
    description:
      'Delete a workout event from the schedule. ' +
      'For recurring events always ask the user first: delete just this one instance, or the entire series? ' +
      'Use scope="instance" + date for a single occurrence; scope="all" to remove the whole event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The event ID shown in [brackets] in the schedule.',
        },
        scope: {
          type: 'string',
          enum: ['instance', 'all'],
          description:
            '"instance" = skip only this date (recurring events only). ' +
            '"all" = delete the event (or entire series) permanently.',
        },
        date: {
          type: 'string',
          description: 'YYYY-MM-DD date of the instance to skip. Required when scope is "instance".',
        },
        event_title: {
          type: 'string',
          description: 'Human-readable event title — shown in the confirmation card.',
        },
        event_date_display: {
          type: 'string',
          description: 'Human-readable date — shown in the confirmation card, e.g. "Monday June 29".',
        },
      },
      required: ['event_id', 'scope', 'event_title'],
    },
  },
  {
    name: 'create_event',
    description: 'Add a new workout event to the schedule.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['stretching', 'morning-routine', 'weights', 'climbing', 'cardio', 'yoga'],
        },
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        estimated_duration: { type: 'number', description: 'Minutes' },
        start_time: { type: 'string', description: 'e.g. "6:30 AM"' },
        difficulty: { type: 'number', description: '1–5' },
        description: { type: 'string' },
        location: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        equipment: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'title', 'date', 'estimated_duration'],
    },
  },
  {
    name: 'update_event',
    description:
      'Update fields on an existing workout event. ' +
      'For recurring event instances (id contains "__"), this updates the base event and affects all future occurrences.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event ID.' },
        event_title: { type: 'string', description: 'Current title — shown in the confirmation card.' },
        changes: {
          type: 'object',
          description: 'Only include fields that should change.',
          properties: {
            title:              { type: 'string' },
            date:               { type: 'string', description: 'YYYY-MM-DD' },
            start_time:         { type: 'string' },
            end_time:           { type: 'string' },
            estimated_duration: { type: 'number' },
            description:        { type: 'string' },
            location:           { type: 'string' },
            difficulty:         { type: 'number' },
          },
        },
      },
      required: ['event_id', 'event_title', 'changes'],
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDisplayLabel(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'delete_event') {
    const scope = input.scope === 'instance' ? '(this instance)' : '(entire series)';
    const date  = (input.event_date_display as string | undefined) ?? (input.date as string | undefined) ?? '';
    return `Delete: ${input.event_title}${date ? ' · ' + date : ''} ${scope}`;
  }
  if (toolName === 'create_event') {
    return `Create: ${input.title} · ${input.type} · ${input.date}`;
  }
  if (toolName === 'update_event') {
    const keys = Object.keys((input.changes as Record<string, unknown>) ?? {}).join(', ');
    return `Update: ${input.event_title} (${keys})`;
  }
  return toolName;
}

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY as string,
  dangerouslyAllowBrowser: true,
});

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useChat() {
  const [messages,       setMessages]       = useState<DisplayMessage[]>([]);
  const [apiMessages,    setApiMessages]    = useState<ApiMessage[]>([]);
  const [pendingAction,  setPendingAction]  = useState<PendingAction | null>(null);
  const [isLoading,      setIsLoading]      = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const abortRef = useRef<(() => void) | null>(null);

  // ── Core streaming helper ──────────────────────────────────────────────────

  async function streamResponse(
    msgs: ApiMessage[],
    systemPrompt: string,
    withTools: boolean,
  ): Promise<{ text: string; toolUse: ToolUseBlock | null }> {
    const stream = client.messages.stream({
      model:    'claude-opus-4-8',
      max_tokens: 1024,
      thinking:  { type: 'adaptive' },
      system:    systemPrompt,
      messages:  msgs as Anthropic.MessageParam[],
      ...(withTools ? { tools: TOOLS } : {}),
    });

    abortRef.current = () => stream.abort();

    let textAccumulated = '';
    let currentTool: { id: string; name: string; json: string } | null = null;
    let finishedTool: ToolUseBlock | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentTool = { id: event.content_block.id, name: event.content_block.name, json: '' };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          textAccumulated += event.delta.text;
          setStreamingContent(textAccumulated);
        } else if (event.delta.type === 'input_json_delta' && currentTool) {
          currentTool.json += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop' && currentTool) {
        finishedTool = {
          type:  'tool_use',
          id:    currentTool.id,
          name:  currentTool.name,
          input: JSON.parse(currentTool.json || '{}') as Record<string, unknown>,
        };
        currentTool = null;
      }
    }

    return { text: textAccumulated, toolUse: finishedTool };
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
          displayLabel: buildDisplayLabel(toolUse.name, toolUse.input),
        });
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: text }]);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
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
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages([{ role: 'assistant', content: "Couldn't reach the coaching server. Check your API key in .env.local." }]);
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
