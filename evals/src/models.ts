import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ApiMessage, CallModel, ModelResponse } from './types';
import { analyticsToolSchemas, builderToolSchemas, coachToolSchemas } from '../../src/lib/coach/schemas';
import { COACH_MODEL } from '../../src/lib/coach/model';
import { COACH_MODELS } from '../../src/lib/coach/models';

// Per-model request params + pricing. The coach-under-test request shape is
// replicated from api/chat.ts: max_tokens 8192, per-model thinking params,
// tools only when enabled.
//
// Pricing is standard (non-introductory) $/MTok so cross-model comparisons
// stay stable after promotional windows lapse.

export interface ModelConfig {
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

// Sourced from the product's own catalog, so every model a user can actually
// select is priceable here — including one the coach is bumped onto.
//
// The catalog is a literal array, which is what preserves the invariant this
// table has always had: pricing is keyed by literal id, never by a computed
// [COACH_MODEL] key. A computed key would let a production bump onto an id
// already in the table — moving the coach down a tier to Sonnet is the very
// comparison this suite exists to inform — silently overwrite that entry's
// pricing, corrupting every cost figure with no type or runtime error. A bump
// to an unpriced id instead fails loudly in modelConfig() below.
export const MODEL_CONFIGS: Record<string, ModelConfig> = Object.fromEntries(
  COACH_MODELS.map(m => [m.id, { id: m.id, inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok }]),
);

/** Default for all eval-infrastructure calls (dev runs, judge). The production arm is COACH_MODEL. */
export const DEFAULT_MODEL = 'claude-sonnet-5';
/** Sourced from src/lib/coach/model.ts — a production model bump moves the eval arm automatically. */
export const PRODUCTION_MODEL = COACH_MODEL;
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

export function modelConfig(id: string): ModelConfig {
  const config = MODEL_CONFIGS[id];
  if (!config) {
    throw new Error(
      `Unknown model "${id}" — add its $/MTok pricing to MODEL_CONFIGS. ` +
      `Known: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
    );
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
  // Per-model, like production: `thinking` is absent on models that predate
  // adaptive thinking and would 400 on it (src/lib/coach/models.ts).
  const params = COACH_MODELS.find(m => m.id === model)?.params ?? { thinking: { type: 'adaptive' as const } };
  return async ({ system, messages, withTools, toolMode }): Promise<ModelResponse> => {
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      ...params,
      system,
      messages: messages as Anthropic.MessageParam[],
      ...(withTools
        ? { tools: toolMode === 'builder' ? builderToolSchemas() : toolMode === 'analytics' ? analyticsToolSchemas() : coachToolSchemas() }
        : {}),
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

// The shell environment wins; .env.local (gitignored) is the fallback so
// harness sessions — which don't inherit an interactive shell's exports —
// can run the suite too. Being gitignored, .env.local never reaches a fresh
// worktree, so a worktree falls through to the primary checkout's copy (its
// .git file points home) — one line there covers every checkout. Only this
// one key is read from the file: the runner has no other env surface, and a
// general dotenv load would invite one.
export function evalApiKey(root = process.cwd()): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const read = (dir: string) => {
    try {
      const raw = readFileSync(join(dir, '.env.local'), 'utf8');
      return raw.match(/^ANTHROPIC_API_KEY=(\S+)\s*$/m)?.[1];
    } catch {
      return undefined;
    }
  };
  const own = read(root);
  if (own) return own;
  try {
    // A linked worktree's .git is a file: `gitdir: <primary>/.git/worktrees/<name>`.
    const gitdir = readFileSync(join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (gitdir) return read(resolve(root, gitdir[1], '..', '..', '..'));
  } catch {
    // .git is a directory (primary) or absent — nowhere further to look.
  }
  return undefined;
}

export function makeClient(): Anthropic {
  const apiKey = evalApiKey();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — export it, or add an ANTHROPIC_API_KEY= line to .env.local. ' +
        'The eval runner calls the API directly.',
    );
  }
  return new Anthropic({ apiKey });
}

export type { ApiMessage };
