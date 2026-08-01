import Anthropic from '@anthropic-ai/sdk';
import type { ApiMessage, CallModel, ModelResponse } from './types';
import { coachToolSchemas } from '../../src/lib/coach/schemas';

// Per-model request params + pricing. The coach-under-test request shape is
// replicated exactly from api/chat.ts: max_tokens 8192, adaptive thinking,
// tools only when enabled. Both configured models accept the same shape.
//
// Pricing is standard (non-introductory) $/MTok so cross-model comparisons
// stay stable after promotional windows lapse.

export interface ModelConfig {
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'claude-sonnet-5': { id: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { id: 'claude-opus-4-8', inputPerMTok: 5, outputPerMTok: 25 },
};

/** Default for all eval-infrastructure calls (dev runs, judge). Opus is the production arm. */
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const PRODUCTION_MODEL = 'claude-opus-4-8';
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

export function modelConfig(id: string): ModelConfig {
  const config = MODEL_CONFIGS[id];
  if (!config) {
    throw new Error(`Unknown model "${id}". Known: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
  }
  return config;
}

export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const c = modelConfig(model);
  return (usage.inputTokens * c.inputPerMTok + usage.outputTokens * c.outputPerMTok) / 1_000_000;
}

/** Production coach request shape (api/chat.ts), against the live API. */
export function makeAnthropicCaller(client: Anthropic, model: string): CallModel {
  modelConfig(model); // fail fast on unknown ids
  return async ({ system, messages, withTools }): Promise<ModelResponse> => {
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      system,
      messages: messages as Anthropic.MessageParam[],
      ...(withTools ? { tools: coachToolSchemas() } : {}),
    });
    const final = await stream.finalMessage();
    return {
      content: final.content as unknown as ModelResponse['content'],
      stopReason: final.stop_reason,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      },
    };
  };
}

export function makeClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. The eval runner calls the API directly.');
  }
  return new Anthropic();
}

export type { ApiMessage };
