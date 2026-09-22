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
// .git file points home) — one line there covers every checkout. Only the
// two credential keys below are read from the file: the runner has no other
// env surface, and a general dotenv load would invite one.

/** One `KEY=value` line of a .env.local, or undefined. Never partial. */
function readEnvLocalKey(dir: string, key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, '.env.local'), 'utf8');
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex(line => line.startsWith(`${key}=`));
  if (i === -1) return undefined;
  // A credential pasted with a hard wrap (a terminal folded it, or an editor
  // did) parses as a SILENTLY TRUNCATED value — the regex stops at the end of
  // the line and the result is a token that looks fine and fails to
  // authenticate with no hint as to why. A continuation line carries no
  // `KEY=` of its own and isn't a comment, which is enough to catch it.
  const next = lines[i + 1];
  if (next !== undefined && next.trim() && !/^\s*(#|[A-Za-z_][A-Za-z0-9_]*=)/.test(next)) {
    throw new Error(
      `${key} in ${join(dir, '.env.local')} is wrapped across two lines, so it would load ` +
        'truncated. Join the value onto one line.',
    );
  }
  return lines[i].slice(key.length + 1).trim() || undefined;
}

/** `.env.local` here, else the primary checkout's (a worktree never has one). */
function readCredential(root: string, key: string): string | undefined {
  const own = readEnvLocalKey(root, key);
  if (own) return own;
  let primary: string | undefined;
  try {
    // A linked worktree's .git is a file: `gitdir: <primary>/.git/worktrees/<name>`.
    const gitdir = readFileSync(join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (gitdir) primary = resolve(root, gitdir[1], '..', '..', '..');
  } catch {
    // .git is a directory (primary) or absent — nowhere further to look.
  }
  // Outside the try: a malformed credential in the primary's .env.local must
  // surface, not be swallowed as "no .git file here".
  return primary ? readEnvLocalKey(primary, key) : undefined;
}

export function evalApiKey(root = process.cwd()): string | undefined {
  return process.env.ANTHROPIC_API_KEY || readCredential(root, 'ANTHROPIC_API_KEY');
}

/** Subscription credential for the agent-sdk backend (`claude setup-token`). */
export function evalOauthToken(root = process.cwd()): string | undefined {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || readCredential(root, 'CLAUDE_CODE_OAUTH_TOKEN');
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
