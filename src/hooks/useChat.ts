import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../context/auth';
import {
  ApiError, authHeaders,
  appendCoachMessages, createCoachConversation, listCoachConversations, loadCoachConversation,
} from '../lib/api';
import type { CoachMode, NewCoachMessage, StoredCoachMessage } from '../lib/api';
import { createWireCollector } from '../lib/coach/wire';
import { toPendingActions, settleHead, appendUserText } from '../lib/coach/actionQueue';
import type { ApiMessage, PendingAction, TextBlock, ToolResultBlock } from '../lib/coach/actionQueue';
import type { WireRead, WireRound, WireToolUse } from '../lib/coach/wire';
import { isServerSideTool, serverSideToolChip } from '../lib/coach/tools';

export type { PendingAction } from '../lib/coach/actionQueue';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DisplayMessage {
  /** Stable across re-renders: the stored row id, or a locally minted one for
   *  a message that has not been saved (or whose save failed). The render
   *  loop keys on this rather than on the array index. */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** What the coach checked before this reply — one chip per server-side
   *  call ("Checked: Deadlift history"), in the order it made them. */
  reads?: string[];
}

/** Shown when the server answers 402: the user has no Anthropic key saved. */
const KEY_SETUP_MESSAGE =
  'To use the coach, add a key from Anthropic. Tap your picture at the top left, then Anthropic key.';

/** Shown when the server answers 429: the per-user chat rate limit tripped. */
const RATE_LIMIT_MESSAGE =
  'The coach is taking a breather — too many requests in a short window. Try again in a few minutes.';

/** The hidden prompt behind Coach's Notes — history the model needs, and a
 *  message the user never wrote, so it is stored with display_text null
 *  (docs/ios/decisions.md D-025). */
export const BRIEFING_PROMPT = 'Give me my coaching briefing for today.';

function isMissingKeyError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 402;
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

let localIdCounter = 0;
/** Id for a message that exists only in memory. Never collides with a stored
 *  uuid, and is not asked to survive anything. */
function localMessageId(): string {
  localIdCounter += 1;
  return `local-${localIdCounter}`;
}

// ─── Persistence shape (exported for testing) ─────────────────────────────────

/**
 * Rebuild both halves of the thread from stored rows (D-013 / D-025).
 *
 * `apiMessages` is replayed with the SAME `appendUserText` fold the live path
 * uses, because that is what a stored row is: the delta the live path
 * appended, not the message it produced. A plain user turn that followed an
 * unanswered tool_result flush folded into that message in memory, and must
 * fold into it again here — a tool_result has to open the user turn after a
 * tool_use, and splitting them would make the first replayed request invalid.
 *
 * Rows with `api_content` null are display-only (a notice, a stopped partial)
 * and never reach the model; rows with `display_text` null are hidden (the
 * briefing prompt) and never reach the thread.
 */
export function hydrateFromRows(rows: StoredCoachMessage[]): {
  messages: DisplayMessage[];
  apiMessages: ApiMessage[];
} {
  const messages: DisplayMessage[] = [];
  let apiMessages: ApiMessage[] = [];
  // The chips of the turn being rebuilt: a server round is a hidden
  // assistant row whose tool_use blocks are all server-side, and its chips
  // belong to the next reply the thread shows. The wire's labels are gone by
  // now; serverSideToolChip names the tool instead.
  let pendingReads: string[] = [];

  for (const row of rows) {
    if (row.role === 'assistant') pendingReads.push(...readChipsOf(row.api_content));
    if (row.display_text !== null && row.display_text !== undefined) {
      const message: DisplayMessage = { id: row.id, role: row.role, content: row.display_text };
      if (row.role === 'assistant' && pendingReads.length > 0) message.reads = pendingReads;
      messages.push(message);
      // A shown user message closes the previous turn: chips left over from
      // a turn that ended with reads and no reply stay with that turn.
      pendingReads = [];
    }
    if (row.api_content === null || row.api_content === undefined) continue;
    if (row.role === 'user' && typeof row.api_content === 'string') {
      apiMessages = appendUserText(apiMessages, row.api_content);
    } else {
      apiMessages = [...apiMessages, { role: row.role, content: row.api_content } as ApiMessage];
    }
  }

  return { messages, apiMessages };
}

/** The chips for the server-side tool_use blocks in a stored assistant row. */
function readChipsOf(apiContent: unknown): string[] {
  if (!Array.isArray(apiContent)) return [];
  return (apiContent as Array<{ type?: unknown; name?: unknown; input?: unknown }>)
    .filter(b => b?.type === 'tool_use' && typeof b.name === 'string' && isServerSideTool(b.name))
    .map(b => serverSideToolChip(b.name as string, b.input));
}

// ─── The sight loop's history (exported for testing) ─────────────────────────

function toolResultOf(read: WireRead): ToolResultBlock {
  const block: ToolResultBlock & { is_error?: boolean } = {
    type: 'tool_result',
    tool_use_id: read.use.id,
    // The structured content when the server sent one (the doctrine's
    // citable document), so a mixed round's post-confirm reply can cite it
    // exactly as a server-continued round could.
    content: read.result.content ?? read.result.text,
  };
  if (read.result.isError) block.is_error = true;
  return block;
}

export interface TurnHistory {
  /** The server rounds as API messages, in order: for each, an assistant
   *  message (the round's text, then its read tool_use blocks) and a user
   *  message of the matching tool_results. */
  serverMessages: ApiMessage[];
  /** The final assistant content: the last text, then — on a mixed
   *  response — the reads that came with the writes, then the writes.
   *  Empty when the model said nothing after its last reads. */
  finalContent: Array<TextBlock | WireToolUse>;
  /** The read results a mixed response's write flush must carry; [] otherwise. */
  heldResults: ToolResultBlock[];
  /** One chip per server-side call across the whole turn. */
  chips: string[];
}

/**
 * Rebuild what the API saw during one turn from the rounds the wire
 * described (createWireCollector), so the stored thread replays as a valid
 * transcript: every read tool_use is answered by a tool_result in the next
 * user message. Two shapes:
 *
 * - Reads that continued the turn (every round but the last) become an
 *   assistant/user pair each. A last round whose reads were answered but
 *   followed by no text is such a pair too, and the final content is empty;
 *   the caller then stores nothing more, and the next user text folds into
 *   the trailing tool_result message (appendUserText).
 * - A last round with reads AND write tool_uses (the model read and asked to
 *   write in one response) keeps its reads in the final assistant message;
 *   their results are held so the confirm flow's flush carries them next to
 *   the write results — the API wants every tool_use of that message
 *   answered in one place.
 */
export function historyForTurn(rounds: WireRound[], toolUses: WireToolUse[]): TurnHistory {
  const last = rounds[rounds.length - 1] ?? { text: '', reads: [] };
  const mixed = toolUses.length > 0 && last.reads.length > 0;
  const serverRounds = mixed ? rounds.slice(0, -1) : rounds.filter(r => r.reads.length > 0);

  const serverMessages: ApiMessage[] = [];
  for (const round of serverRounds) {
    const assistant: Array<TextBlock | WireToolUse> = [];
    if (round.text) assistant.push({ type: 'text', text: round.text });
    assistant.push(...round.reads.map(r => r.use));
    serverMessages.push({ role: 'assistant', content: assistant });
    serverMessages.push({ role: 'user', content: round.reads.map(toolResultOf) });
  }

  const finalText = !mixed && last.reads.length > 0 ? '' : last.text;
  const finalContent: Array<TextBlock | WireToolUse> = [];
  if (finalText) finalContent.push({ type: 'text', text: finalText });
  if (mixed) finalContent.push(...last.reads.map(r => r.use));
  finalContent.push(...toolUses);

  return {
    serverMessages,
    finalContent,
    heldResults: mixed ? last.reads.map(toolResultOf) : [],
    chips: rounds.flatMap(r => r.reads.map(read => read.label)),
  };
}

/** The final assistant content as the thread stores it — a plain string for
 *  a text-only reply, the block array otherwise (the shape the model saw). */
export function assistantApiContent(finalContent: Array<TextBlock | WireToolUse>): string | Array<TextBlock | WireToolUse> {
  return finalContent.length === 1 && finalContent[0].type === 'text' ? finalContent[0].text : finalContent;
}

/** A display-only row: something the thread shows that the model never said. */
export function noticeRow(message: string): NewCoachMessage {
  return { role: 'assistant', api_content: null, display_text: message, kind: 'notice' };
}

/** One stored turn. `displayText` null makes it a hidden row. */
export function turnRow(
  role: 'user' | 'assistant',
  apiContent: unknown,
  displayText: string | null,
): NewCoachMessage {
  return { role, api_content: apiContent, display_text: displayText, kind: 'turn' };
}

/**
 * What a completed chat turn stores. The user row carries the PLAIN TEXT, not
 * the message `appendUserText` produced: a stored row is the delta, and
 * hydrateFromRows replays the same fold. `assistantText` empty (a turn that
 * was only tool_use blocks) stores an assistant row with nothing to render.
 */
export function rowsForUserTurn(
  userText: string,
  assistantApiContent: unknown,
  assistantText: string,
): NewCoachMessage[] {
  return [
    turnRow('user', userText, userText),
    turnRow('assistant', assistantApiContent, assistantText || null),
  ];
}

/** What a settled tool_result flush stores: model history with nothing to render. */
export function rowsForToolFlush(
  flushed: ToolResultBlock[],
  assistantText: string,
): NewCoachMessage[] {
  return [
    turnRow('user', flushed, null),
    turnRow('assistant', assistantText, assistantText || null),
  ];
}

/** What Coach's Notes stores: the synthetic prompt HIDDEN, the briefing shown. */
export function rowsForBriefing(assistantText: string): NewCoachMessage[] {
  return [
    turnRow('user', BRIEFING_PROMPT, null),
    turnRow('assistant', assistantText, assistantText || null),
  ];
}

/**
 * The write-behind save itself, FAIL-OPEN by contract: the rows are already
 * on screen and already in `apiMessages`, so a rejection is a console.warn
 * and `false`, never a throw. The thread carries on in memory exactly as it
 * did before persistence existed. Module-level so the contract is testable
 * without rendering the hook.
 */
export async function saveRows(
  ensureConversationId: () => Promise<string>,
  rows: NewCoachMessage[],
): Promise<boolean> {
  if (rows.length === 0) return false;
  try {
    const id = await ensureConversationId();
    await appendCoachMessages(id, rows);
    return true;
  } catch (err) {
    console.warn('[apex] coach thread not saved:', err);
    return false;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseChatOptions {
  /** 'builder' scopes the server's tool list to update_workout_draft. */
  toolMode?: CoachMode;
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
  const mode: CoachMode = toolMode ?? 'chat';
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
  /** Chips for the server-side calls of the turn in flight, as they start. */
  const [streamingReads, setStreamingReads] = useState<string[]>([]);
  const abortRef = useRef<(() => void) | null>(null);
  // Carried in every callback's dep list below, not just closed over: these
  // are memoized on other state, so a switch in the picker with no other
  // change would otherwise keep sending the previous model.
  const coachModel = profile?.coach_model ?? undefined;

  // ── Thread persistence (D-013) ────────────────────────────────────────────
  // The id lives in a ref as well as in state: saves run inside async
  // callbacks that captured an earlier render, and the one thing they must
  // not do is create a second conversation because the state had not landed.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  const setConversation = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  // Hydrate from the newest thread for this surface. Every failure here is
  // swallowed: the thread the user gets is the empty one the app had before
  // persistence existed, which is a worse experience and not a broken one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { conversations } = await listCoachConversations(mode);
        const newest = conversations?.[0];
        if (!newest || cancelled) return;
        const { messages: rows } = await loadCoachConversation(newest.id);
        if (cancelled) return;
        const hydrated = hydrateFromRows(rows ?? []);
        setConversation(newest.id);
        setMessages(hydrated.messages);
        setApiMessages(hydrated.apiMessages);
      } catch (err) {
        console.warn('[apex] coach thread did not load:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, setConversation]);

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (conversationIdRef.current) return conversationIdRef.current;
    const { conversation } = await createCoachConversation(mode);
    setConversation(conversation.id);
    return conversation.id;
  }, [mode, setConversation]);

  const persist = useCallback(
    (rows: NewCoachMessage[]) => saveRows(ensureConversation, rows),
    [ensureConversation],
  );

  /** Start an empty thread: a new conversation, and nothing on screen. */
  const newThread = useCallback(async (): Promise<void> => {
    setMessages([]);
    setApiMessages([]);
    setPendingActions([]);
    setHeldResults([]);
    setStreamingContent('');
    // Created eagerly so the empty thread is a real one the next reload finds
    // — but a failure is not fatal: persist() creates one on the first save.
    setConversation(null);
    try {
      const { conversation } = await createCoachConversation(mode);
      setConversation(conversation.id);
    } catch (err) {
      console.warn('[apex] new coach thread not created:', err);
    }
  }, [mode, setConversation]);

  // ── Core streaming helper — reads NDJSON wire events from /api/chat ───────

  async function streamResponse(
    msgs: ApiMessage[],
    ctx: ChatContext,
    withTools: boolean,
  ): Promise<{ text: string; toolUses: WireToolUse[]; rounds: WireRound[]; reads: WireRead[]; notices: string[] }> {
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

    const collector = createWireCollector(setStreamingContent, setStreamingReads);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(decoder.decode(value, { stream: true }));
    }
    collector.end();

    return {
      text: collector.text,
      toolUses: collector.toolUses,
      rounds: collector.rounds,
      reads: collector.reads,
      notices: collector.notices,
    };
  }

  // ── sendMessage ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (content: string, ctx: ChatContext) => {
    setIsLoading(true);
    setStreamingContent('');
    setStreamingReads([]);

    const userDisplayMsg: DisplayMessage = { id: localMessageId(), role: 'user', content };

    setMessages(prev => [...prev, userDisplayMsg]);

    // appendUserText folds the text into a trailing unanswered tool_result
    // message if the last flush stream failed — see actionQueue.ts.
    const nextApiMessages = appendUserText(apiMessages, content);
    setApiMessages(nextApiMessages);

    try {
      const { text, toolUses, rounds, notices } = await streamResponse(nextApiMessages, ctx, true);

      // The server may have read before it spoke (the sight loop): every
      // server round is an assistant/user pair the history must carry, then
      // the final assistant message (text, and any write tool_use blocks).
      const { serverMessages, finalContent, heldResults: readResults, chips } = historyForTurn(rounds, toolUses);
      const rows: NewCoachMessage[] = [turnRow('user', content, content)];
      let history: ApiMessage[] = [...nextApiMessages, ...serverMessages];
      for (const m of serverMessages) rows.push(turnRow(m.role, m.content, null));

      if (finalContent.length > 0) {
        const assistantApiMsg: ApiMessage = { role: 'assistant', content: assistantApiContent(finalContent) };
        history = [...history, assistantApiMsg];
        rows.push(turnRow('assistant', assistantApiMsg.content, text || null));
      } else if (text) {
        // Reads with no reply after them: the words shown came from an
        // earlier round (already stored hidden), so the thread keeps them as
        // a display-only row. The next user text folds into the trailing
        // tool_result message (appendUserText), which keeps the history valid.
        rows.push(turnRow('assistant', null, text));
      }
      setApiMessages(history);

      const reads = chips.length > 0 ? chips : undefined;
      if (toolUses.length > 0) {
        // Show any pre-tool text Claude spoke, then surface the pending
        // actions — one confirmation card at a time, in emission order.
        if (text || reads) setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: text, reads }]);
        // A mixed response's read results flush with the write results.
        setHeldResults(readResults);
        setPendingActions(toPendingActions(toolUses));
      } else if (text || reads) {
        setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: text, reads }]);
      }
      for (const message of notices) {
        setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: message }]);
        rows.push(noticeRow(message));
      }

      // The turn completed: store the user's words, the rounds, and the
      // assistant's reply as one batch.
      void persist(rows);
    } catch (err: unknown) {
      // Nothing is stored for a failed turn: the user message never reached a
      // reply, and a half-turn replayed on the next load would be a question
      // the coach appears to have ignored.
      if (isMissingKeyError(err)) {
        setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: KEY_SETUP_MESSAGE }]);
      } else if (isRateLimitError(err)) {
        setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: RATE_LIMIT_MESSAGE }]);
      } else if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: 'Sorry, I ran into an error. Please try again.' }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      setStreamingReads([]);
      abortRef.current = null;
    }
  }, [apiMessages, coachModel, persist]);

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
      setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: text }]);
      setApiMessages(prev => [...prev, { role: 'assistant', content: text }]);
      void persist(rowsForToolFlush(flushed, text));
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError' && failureMessage) {
        setMessages(prev => [...prev, { id: localMessageId(), role: 'assistant', content: failureMessage }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [pendingActions, heldResults, apiMessages, coachModel, persist]);

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

    const syntheticUser: ApiMessage = { role: 'user', content: BRIEFING_PROMPT };

    // A briefing replaces the thread on screen, so it replaces the thread in
    // storage too: a fresh conversation rather than a briefing appended to
    // yesterday's chat. Best-effort — a failure leaves persist() to create
    // one, which is the same fail-open path every other save takes.
    let fresh: string | null = null;
    try {
      const { conversation } = await createCoachConversation(mode);
      fresh = conversation.id;
      setConversation(fresh);
    } catch (err) {
      console.warn('[apex] briefing thread not created:', err);
      setConversation(null);
    }

    try {
      const { text } = await streamResponse([syntheticUser], ctx, false);
      const assistantMsg: ApiMessage = { role: 'assistant', content: text };
      // Seed apiMessages so follow-up chat has valid history
      setApiMessages([syntheticUser, assistantMsg]);
      setMessages([{ id: localMessageId(), role: 'assistant', content: text }]);
      // The synthetic prompt is stored HIDDEN (display_text null): the model
      // needs it in history, the user never wrote it and never sees it.
      void persist(rowsForBriefing(text));
    } catch (err: unknown) {
      if (isMissingKeyError(err)) {
        setMessages([{ id: localMessageId(), role: 'assistant', content: KEY_SETUP_MESSAGE }]);
      } else if (isRateLimitError(err)) {
        setMessages([{ id: localMessageId(), role: 'assistant', content: RATE_LIMIT_MESSAGE }]);
      } else if (err instanceof Error && err.name !== 'AbortError') {
        setMessages([{ id: localMessageId(), role: 'assistant', content: "Couldn't reach the coaching server. Please try again." }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [coachModel, mode, persist, setConversation]);

  const abort = useCallback(() => { abortRef.current?.(); }, []);

  return {
    messages,
    isLoading,
    streamingContent,
    /** "Checked: …" for the turn in flight, in the order the calls started. */
    streamingReads,
    /** Head of the queue — the action currently awaiting confirm/cancel. */
    pendingAction: pendingActions[0] ?? null,
    /** How many actions remain (including the one showing), for "1 of N" UI. */
    pendingActionCount: pendingActions.length,
    /** The stored thread this panel is writing to; null until the first save. */
    conversationId,
    sendMessage,
    confirmAction,
    cancelAction,
    triggerInitial,
    /** Clear the panel and start a fresh stored thread. */
    newThread,
    abort,
  };
}
