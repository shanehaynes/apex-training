import { findCoachTool } from './tools.js';
import type { WireToolUse } from './wire.js';

// The pending-action queue for parallel tool calls. When a response carries
// several tool_use blocks, each becomes a PendingAction the user confirms or
// cancels one at a time — but the Anthropic API requires the NEXT user
// message to open with a tool_result for EVERY tool_use in the assistant
// turn, so results accumulate here and flush as one message only after the
// last action settles. React-free so the queue semantics stay unit-testable.

export interface PendingAction {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** One-liner shown in the confirmation card, e.g. "Delete: Upper Body · Mon Jun 29" */
  displayLabel: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

// Matches what the Anthropic API accepts in the messages array — the shapes
// are forwarded verbatim by /api/chat.
export type ApiMessage = {
  role: 'user';
  content: string | Array<ToolResultBlock | TextBlock>;
} | {
  role: 'assistant';
  content: string | Array<TextBlock | WireToolUse>;
};

/**
 * Append a user text message to the conversation. If the history ends with
 * an unanswered tool_result message (the post-confirm stream failed or was
 * aborted before the coach replied), fold the text into that message instead
 * — tool_result blocks must open the user turn that follows a tool_use
 * assistant turn, so keeping them and the new text in ONE message stays
 * valid regardless of how the API treats consecutive user turns.
 */
export function appendUserText(messages: ApiMessage[], text: string): ApiMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    const merged: ApiMessage = {
      role:    'user',
      content: [...last.content, { type: 'text', text }],
    };
    return [...messages.slice(0, -1), merged];
  }
  return [...messages, { role: 'user', content: text }];
}

/** One PendingAction per tool_use block, in the order the model emitted them. */
export function toPendingActions(toolUses: WireToolUse[]): PendingAction[] {
  return toolUses.map(tu => ({
    toolUseId:    tu.id,
    toolName:     tu.name,
    input:        tu.input,
    displayLabel: findCoachTool(tu.name)?.displayLabel(tu.input) ?? tu.name,
  }));
}

export interface SettledQueue {
  /** Actions still awaiting the user's confirm/cancel. */
  queue: PendingAction[];
  /** Results held back until the whole queue settles. */
  results: ToolResultBlock[];
  /** Non-null once every action has settled: the complete tool_result set,
   *  one per original tool_use, ready to send as a single user message. */
  flushed: ToolResultBlock[] | null;
}

/**
 * Settle the head of the queue with its tool_result text (an execution
 * outcome or "Cancelled by user."). Returns the advanced queue; when the
 * last action settles, `flushed` carries every result and the held state
 * resets.
 */
export function settleHead(
  queue: PendingAction[],
  results: ToolResultBlock[],
  resultText: string,
): SettledQueue {
  const [head, ...rest] = queue;
  if (!head) return { queue, results, flushed: null };

  const nextResults: ToolResultBlock[] = [
    ...results,
    { type: 'tool_result', tool_use_id: head.toolUseId, content: resultText },
  ];
  return rest.length > 0
    ? { queue: rest, results: nextResults, flushed: null }
    : { queue: [],   results: [],          flushed: nextResults };
}
