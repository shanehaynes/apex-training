import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { analyticsToolSchemas, builderToolSchemas, coachToolSchemas } from '../../../src/lib/coach/schemas';
import { COACH_MODELS } from '../../../src/lib/coach/models';
import type {
  ApiMessage,
  Backend,
  TextBlock,
  ToolUseBlock,
  TurnOutcome,
  TurnRequest,
  TurnToolCall,
} from '../types';

// The subscription backend. Drives the coach through the Claude Agent SDK —
// i.e. through a local Claude Code process authenticated by `claude
// setup-token` — so a PR-time eval run spends a Claude subscription and never
// an API key. Subscription entitlement reaches models only this way; the
// Messages API cannot see it.
//
// This is a REGRESSION DETECTOR, not a production replica. The API backend
// stays the production-shaped measurement of record. The differences are
// enumerated in evals/README.md ("Backends") and are structural, not
// incidental — most of all that there is no tools-off re-stream here: where
// production re-streams with tool_choice: none after the confirmed tool
// results, the SDK simply continues inside the same query.

export const MCP_SERVER_NAME = 'coach';
export const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** The SDK exposes MCP tools as `mcp__<server>__<tool>` on the wire; every
 *  checker, expectation and transcript in this suite is written against the
 *  production tool names, so the prefix comes off before anything sees it. */
export function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Fails a case rather than being scored as coach behavior — see the auth
 *  guard below: a not-logged-in SDK answers with a synthetic assistant
 *  message, which is a broken harness, not a refusal. */
export class AgentSdkBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSdkBackendError';
  }
}

/** `tool()` wants a Zod raw shape; schemas.ts is the production JSON Schema
 *  and stays the single source of truth, so it is converted, never retyped. */
export function zodShapeFromJsonSchema(inputSchema: unknown): z.ZodRawShape {
  const converted = z.fromJSONSchema(
    inputSchema as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodObject<z.ZodRawShape>;
  return converted.shape;
}

function schemasFor(toolMode?: 'builder' | 'analytics') {
  if (toolMode === 'builder') return builderToolSchemas();
  if (toolMode === 'analytics') return analyticsToolSchemas();
  return coachToolSchemas();
}

type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// Prompt caching is automatic and not controllable here, so a raw
// input_tokens would undercount the context the coach actually saw by an
// order of magnitude and make the two backends' token columns incomparable.
// Cached reads are counted at full weight instead: the token VOLUME matches
// the API backend, and the dollar figure is a notional API-equivalent upper
// bound (the run itself costs nothing — it is a subscription).
export function tokensFromSdkUsage(usage: SdkUsage | undefined) {
  return {
    inputTokens:
      (usage?.input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
  };
}

interface Executed {
  name: string;
  input: Record<string, unknown>;
  resultText: string;
  consumed: boolean;
}

export interface AgentSdkBackendOptions {
  model: string;
  /** From `claude setup-token`. Placed in the subprocess environment; an
   *  ANTHROPIC_API_KEY is stripped from it, so this backend cannot silently
   *  fall back to billing a key. */
  oauthToken?: string;
  /** Bound per SCRIPTED turn — the SDK may run several tool rounds inside one. */
  maxTurns?: number;
  /** Injected in tests so no live model is needed. `tools` is the same array
   *  handed to the MCP server, which is how a fake stream invokes a coach tool
   *  the way a real session would — the production path ignores it. */
  runQuery?: (params: {
    prompt: string;
    options: Options;
    tools: Array<SdkMcpToolDefinition<never>>;
  }) => AsyncIterable<SDKMessage>;
}

const DEFAULT_MAX_TURNS = 12;

export function makeAgentSdkBackend(opts: AgentSdkBackendOptions): Backend {
  const thinking = COACH_MODELS.find(m => m.id === opts.model)?.params?.thinking;
  const runQuery = opts.runQuery
    ?? (({ prompt, options }) => query({ prompt, options }));

  // `env` REPLACES the subprocess environment wholesale, so it is built from
  // process.env minus every API-key path. This is the mechanical half of
  // "the agent-sdk backend never spends a key".
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  if (opts.oauthToken) childEnv.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;

  const runTurn = async (req: TurnRequest): Promise<TurnOutcome> => {
    const { userText, transcript, buildSystem, executeTool, toolMode, turnIndex, session, anomaly } = req;

    const executed: Executed[] = [];
    const sdkTools = schemasFor(toolMode).map(schema =>
      tool(
        schema.name,
        schema.description ?? '',
        zodShapeFromJsonSchema(schema.input_schema),
        async (args: unknown) => {
          const input = (args ?? {}) as Record<string, unknown>;
          let resultText: string;
          try {
            resultText = await executeTool(schema.name, input);
          } catch (err) {
            resultText = 'The operation failed — something went wrong on the backend.';
            anomaly(`executorThrew:${schema.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
          executed.push({ name: schema.name, input, resultText, consumed: false });
          return { content: [{ type: 'text' as const, text: resultText }] };
        },
      ),
    );

    const matchExecuted = (name: string, input: Record<string, unknown>): Executed | undefined => {
      const exact = executed.findIndex(
        e => !e.consumed && e.name === name && JSON.stringify(e.input) === JSON.stringify(input),
      );
      // Zod parse can normalize the input on the way to the handler, so an
      // exact match is preferred but not required; order within a name is the
      // fallback, which is how the SDK runs them anyway.
      const i = exact >= 0 ? exact : executed.findIndex(e => !e.consumed && e.name === name);
      if (i < 0) return undefined;
      executed[i].consumed = true;
      return executed[i];
    };

    transcript.push({ role: 'user', content: userText });

    let pending: Array<TextBlock | ToolUseBlock> = [];
    let outstanding: ToolUseBlock[] = [];
    const assistantBlocks: Array<TextBlock | ToolUseBlock> = [];
    const texts: string[] = [];
    const toolCalls: TurnToolCall[] = [];
    let stopReason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let sessionId = session?.id;

    // One assistant message per contiguous run of blocks, a tool_result user
    // message per settled round — the same ApiMessage[] shape the checkers
    // and the judge read from the API backend.
    const flushAssistant = () => {
      if (!pending.length) return;
      const onlyText = pending.length === 1 && pending[0].type === 'text';
      transcript.push({
        role: 'assistant',
        content: onlyText ? (pending[0] as TextBlock).text : pending,
      });
      pending = [];
    };

    const settle = () => {
      if (!outstanding.length) return;
      flushAssistant();
      const results = outstanding.map(toolUse => {
        const hit = matchExecuted(toolUse.name, toolUse.input);
        if (!hit) anomaly(`sdkToolResultMissing:${toolUse.name} (turn ${turnIndex})`);
        const resultText = hit?.resultText ?? `Unknown tool "${toolUse.name}".`;
        toolCalls.push({ name: toolUse.name, input: toolUse.input, resultText });
        return { type: 'tool_result' as const, tool_use_id: toolUse.id, content: resultText };
      });
      transcript.push({ role: 'user', content: results } as ApiMessage);
      outstanding = [];
    };

    const options: Options = {
      model: opts.model,
      systemPrompt: buildSystem(),
      // `tools: []` is the lever that actually removes the built-ins;
      // `allowedTools: []` leaves every one of them in the prompt.
      tools: [],
      // Without this the query inherits the developer's own settings, MCP
      // servers and slash commands — personal config scoring the coach.
      settingSources: [],
      mcpServers: {
        [MCP_SERVER_NAME]: createSdkMcpServer({
          name: MCP_SERVER_NAME,
          version: '1.0.0',
          tools: sdkTools,
          alwaysLoad: true,
        }),
      },
      permissionMode: 'bypassPermissions',
      maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
      env: childEnv,
      ...(thinking ? { thinking } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
    };

    let stream: AsyncIterable<SDKMessage>;
    try {
      stream = runQuery({
        prompt: userText,
        options,
        tools: sdkTools as unknown as Array<SdkMcpToolDefinition<never>>,
      });
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          const builtins = (message.tools ?? []).filter(t => !t.startsWith(MCP_PREFIX));
          if (builtins.length) {
            anomaly(`sdkBuiltinToolsPresent:${builtins.join(',')} (turn ${turnIndex})`);
          }
          continue;
        }

        if (message.type === 'assistant') {
          const apiMessage = message.message;
          // Not-logged-in, budget and transport failures all arrive as a
          // synthetic assistant message carrying prose. Scoring that as coach
          // output would silently turn a broken harness into a refusal
          // verdict, so it fails the case instead.
          if (apiMessage.model === '<synthetic>') {
            const prose = apiMessage.content
              .map(b => (b.type === 'text' ? b.text : ''))
              .join(' ')
              .trim();
            throw new AgentSdkBackendError(
              `Agent SDK returned a synthetic message instead of model output: ${prose || '(no text)'}`,
            );
          }
          settle();
          for (const block of apiMessage.content) {
            // Thinking never enters history — the wire protocol drops it.
            if (block.type === 'text') {
              pending.push({ type: 'text', text: block.text });
              assistantBlocks.push({ type: 'text', text: block.text });
              texts.push(block.text);
            } else if (block.type === 'tool_use') {
              const toolUse: ToolUseBlock = {
                type: 'tool_use',
                id: String(block.id),
                name: stripMcpPrefix(String(block.name)),
                input: (block.input ?? {}) as Record<string, unknown>,
              };
              pending.push(toolUse);
              outstanding.push(toolUse);
              assistantBlocks.push(toolUse);
            }
          }
          if (apiMessage.stop_reason) stopReason = apiMessage.stop_reason;
          continue;
        }

        if (message.type === 'result') {
          sessionId = message.session_id;
          if (message.subtype !== 'success' || message.is_error) {
            throw new AgentSdkBackendError(
              `Agent SDK result ${message.subtype}${message.is_error ? ' (is_error)' : ''}: ` +
                `${'result' in message ? String(message.result).slice(0, 200) : ''}`,
            );
          }
          stopReason = message.stop_reason ?? stopReason;
          usage = tokensFromSdkUsage(message.usage as SdkUsage);
        }
      }
    } catch (err) {
      if (err instanceof AgentSdkBackendError) throw err;
      throw new AgentSdkBackendError(err instanceof Error ? err.message : String(err));
    }

    settle();
    flushAssistant();

    if (stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use') {
      anomaly(`stop_reason:${stopReason} (turn ${turnIndex})`);
    }

    return {
      assistantBlocks,
      assistantText: texts.filter(Boolean).join('\n'),
      toolCalls,
      stopReason,
      usage,
      ...(sessionId ? { session: { id: sessionId } } : {}),
    };
  };

  return { kind: 'agent-sdk', runTurn };
}
