import type Anthropic from '@anthropic-ai/sdk';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, zodShapeFromJsonSchema } from './agentSdk';

// The judge's one model call, behind an interface, so the refusal judge can
// run on either backend without knowing which.
//
// The two are NOT equivalent and the difference is the judge's only real
// fidelity gap: the API judge FORCES the verdict tool with `tool_choice`, so a
// structured verdict is guaranteed. The Agent SDK has no tool_choice, so the
// SDK judge can only instruct the call in the prompt. A judge that answers in
// prose instead returns null here, which refusal.ts already treats as a fail —
// the same way it has always treated a missing tool call.

export interface JudgeToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface JudgeRequest {
  system: string;
  userText: string;
  tool: JudgeToolSpec;
}

/** Returns the tool input the judge emitted, or null if it emitted none. */
export type JudgeCall = (req: JudgeRequest) => Promise<Record<string, unknown> | null>;

export function makeApiJudge(client: Anthropic, model: string): JudgeCall {
  return async ({ system, userText, tool: spec }) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      // Disabled, not adaptive: forced tool_choice + thinking is the one combo
      // with cross-platform compatibility caveats, and classification gains
      // nothing from it.
      thinking: { type: 'disabled' },
      tools: [spec as unknown as Anthropic.Tool],
      tool_choice: { type: 'tool', name: spec.name },
      system,
      messages: [{ role: 'user', content: userText }],
    });
    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return null;
    return toolUse.input as Record<string, unknown>;
  };
}

export interface AgentSdkJudgeOptions {
  model: string;
  oauthToken?: string;
  runQuery?: (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
}

export function makeAgentSdkJudge(opts: AgentSdkJudgeOptions): JudgeCall {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  if (opts.oauthToken) childEnv.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
  const runQuery = opts.runQuery ?? (params => query(params));

  return async ({ system, userText, tool: spec }) => {
    let captured: Record<string, unknown> | null = null;
    const verdictTool = tool(
      spec.name,
      spec.description,
      zodShapeFromJsonSchema(spec.input_schema),
      async (args: unknown) => {
        captured = (args ?? {}) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: 'Verdict recorded.' }] };
      },
    );

    const options: Options = {
      model: opts.model,
      // No tool_choice on this path, so the instruction carries it.
      systemPrompt:
        `${system}\n\nYou MUST record your verdict by calling the ${spec.name} tool exactly once. ` +
        'Do not answer in prose.',
      tools: [],
      settingSources: [],
      mcpServers: {
        [MCP_SERVER_NAME]: createSdkMcpServer({
          name: MCP_SERVER_NAME,
          version: '1.0.0',
          tools: [verdictTool],
          alwaysLoad: true,
        }),
      },
      permissionMode: 'bypassPermissions',
      maxTurns: 4,
      thinking: { type: 'disabled' },
      env: childEnv,
    };

    for await (const message of runQuery({ prompt: userText, options })) {
      if (message.type === 'result' && (message.subtype !== 'success' || message.is_error)) {
        return null;
      }
    }
    return captured;
  };
}
