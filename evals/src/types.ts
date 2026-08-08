import type { ExerciseDefinition, WorkoutEvent } from '../../src/types/workout';
import type { Meal } from '../../src/types/nutrition';
import type { BlockPromptSummary } from '../../src/lib/blocks/promptSummary';
import type { ApiMessage, TextBlock, ToolResultBlock } from '../../src/lib/coach/actionQueue';
import type { WireToolUse } from '../../src/lib/coach/wire';

// Core types for the coach eval harness. The harness mirrors useChat.ts +
// actionQueue.ts: every tool_use in a response is confirmed in order, the
// results flush as ONE tool_result user message, tools are disabled on the
// post-confirm re-stream, and thinking blocks are dropped from history.

// ─── Conversation wire shapes ────────────────────────────────────────────────
// Re-exported from the production modules so the harness cannot drift from
// the shapes useChat.ts actually sends.

export type { ApiMessage, TextBlock, ToolResultBlock };
export type ToolUseBlock = WireToolUse;

// ─── Model abstraction ───────────────────────────────────────────────────────

/** One model call, production-shaped. Injected so tests need no SDK mock. */
export type CallModel = (req: {
  system: string;
  messages: ApiMessage[];
  withTools: boolean;
}) => Promise<ModelResponse>;

export interface ModelResponse {
  /** Content blocks as returned by the API (thinking/text/tool_use). */
  content: Array<Record<string, unknown> & { type: string }>;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

// ─── Cases ───────────────────────────────────────────────────────────────────

export type ScriptStep =
  | { kind: 'user'; text: string }
  /** Repeat `text` while the previous turn produced a tool call, up to `max` times. */
  | { kind: 'auto-continue'; text?: string; max: number };

export type RefusalExpectation = 'refuse' | 'pushback' | 'comply';

export interface EvalCase {
  id: string;
  description: string;
  fixture: {
    /** ISO date — pins the clock so runs are comparable. */
    today: string;
    events: WorkoutEvent[];
    /** Defaults to the full 69-entry library. */
    definitions?: ExerciseDefinition[];
    athlete?: { goal?: string; context?: string };
    /** Active training block — exercises prompt.ts's blockSection. */
    block?: BlockPromptSummary | null;
    /** Logged meals — today's render into the prompt's <meals> section. */
    meals?: Meal[];
  };
  script: ScriptStep[];
  expect: {
    constraints?: {
      bannedPatterns: string[];
      loadCaps?: { pattern: string; maxLb: number }[];
      /** Only judge tool calls from this turn on (1-indexed) — for injuries disclosed mid-conversation. */
      fromTurn?: number;
    };
    progression?: {
      metric: 'weeklySets' | 'weeklyMinutes' | 'weeklyRepVolume';
      /** Restrict the metric to exercises carrying this pattern. */
      pattern?: string;
      maxWeekOverWeekIncreasePct: number;
      deload?: { allowed: true; maxDropPct: number };
      direction?: 'build' | 'taper';
    };
    refusal?: {
      expected: RefusalExpectation;
      rubric: string;
      /** Override the default acceptable-behavior set for this expectation. */
      acceptable?: JudgeBehavior[];
    };
    integrity?: {
      /** Fail if the model created a library entry with any of these names. */
      noNewDefinitionsMatching?: string[];
      /** Fail unless a confirmed call of this name ran (optionally matching input keys / result text). */
      requireToolCall?: {
        name: string;
        inputMatches?: Record<string, unknown>;
        resultIncludes?: string;
      };
      /** Fail if any of these tools were called at all. */
      forbidToolCalls?: string[];
    };
  };
}

// ─── Harness output ──────────────────────────────────────────────────────────

export interface RecordedToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The tool_result string, byte-identical to what production would produce. */
  result: string;
  turn: number;
}

export interface TurnRecord {
  userText: string;
  assistantText: string;
  stopReason: string | null;
  latencyMs: number;
}

export interface HarnessResult {
  transcript: ApiMessage[];
  turns: TurnRecord[];
  toolCalls: RecordedToolCall[];
  finalEvents: WorkoutEvent[];
  finalDefinitions: ExerciseDefinition[];
  finalMeals: Meal[];
  createdDefinitionNames: string[];
  anomalies: string[];
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

// ─── Verdicts & results ──────────────────────────────────────────────────────

export type VerdictStatus = 'pass' | 'fail' | 'needs-taxonomy' | 'skipped';

export interface DimensionVerdict {
  status: VerdictStatus;
  detail: string[];
}

export type JudgeBehavior =
  | 'refused'
  | 'pushed_back_then_refused'
  | 'pushed_back_then_complied'
  | 'complied_modified'
  | 'complied';

export interface RefusalVerdict extends DimensionVerdict {
  behavior?: JudgeBehavior;
  reasoning?: string;
}

export interface CaseResult {
  id: string;
  verdicts: {
    constraints?: DimensionVerdict;
    progression?: DimensionVerdict;
    refusal?: RefusalVerdict;
    integrity?: DimensionVerdict;
  };
  turns: number;
  toolCallCount: number;
  anomalies: string[];
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  latencyMs: number;
  transcriptHash: string;
  transcriptPath: string;
  error?: string;
}

export interface RunResult {
  runId: string;
  timestamp: string;
  model: string;
  judgeModel: string;
  gitCommit: string;
  /** sha256 over the coach behavior surface (prompt.ts, schemas.ts, tools.ts,
   *  model.ts) — detects drift between runs; schema/executor edits change
   *  coach behavior as much as prompt edits do. */
  promptFileHash: string;
  cases: CaseResult[];
  aggregate: {
    passRateByDimension: Record<string, { pass: number; fail: number; other: number }>;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    meanLatencyMs: number;
  };
}
