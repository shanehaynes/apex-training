import type { ExerciseDefinition, WorkoutEvent } from '../../src/types/workout';
import type { Meal } from '../../src/types/nutrition';
import type { WorkoutDraft } from '../../src/lib/builder/draft';
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
  /** Scoped single-tool lists (api/chat.ts toolMode). */
  toolMode?: 'chat' | 'builder' | 'analytics';
}) => Promise<ModelResponse>;

export interface ModelResponse {
  /** Content blocks as returned by the API (thinking/text/tool_use). */
  content: Array<Record<string, unknown> & { type: string }>;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

// ─── Turn-level backend seam ─────────────────────────────────────────────────
//
// CallModel above is ONE Messages call over a harness-owned transcript. The
// Agent SDK cannot be driven that way: query() takes a prompt, not a messages
// array carrying prior tool_use/tool_result blocks, and it executes tools
// inside its own session. So the unit the harness drives is a whole scripted
// TURN — user text in, assistant blocks + executed tool calls out — and each
// backend owns whatever it takes to produce one.
//
// The API backend implements this over CallModel and keeps the old loop
// (tools-on call → confirm every tool_use → one flushed tool_result message →
// tools-off re-stream) byte-for-byte, so nothing about an `--backend api` run
// moves. CallModel itself is unchanged.

export type BackendKind = 'api' | 'agent-sdk';

/** Opaque continuation between scripted turns. The API backend needs none —
 *  the transcript IS the state; the SDK backend carries its session id. */
export interface SessionHandle {
  id: string;
}

/** One tool the turn actually executed, against the harness's in-memory deps. */
export interface TurnToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The tool_result string, byte-identical to what production would produce. */
  resultText: string;
}

export interface TurnRequest {
  /** The scripted user message opening this turn. */
  userText: string;
  /** Live transcript. The backend appends the user message and every message
   *  the turn produced, so the record is the same ApiMessage[] either way. */
  transcript: ApiMessage[];
  /** Rebuilt from the mutated fixture before every call, as ChatSidebar's
   *  resolveSystemPrompt does. */
  buildSystem: () => string;
  /** Runs one coach tool against the in-memory deps; returns the tool_result. */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Scoped single-tool lists (api/chat.ts toolMode); absent for the sidebar. */
  toolMode?: 'builder' | 'analytics';
  /** 1-indexed, for anomaly labelling. */
  turnIndex: number;
  session?: SessionHandle;
  /** Appended to the run's anomaly list in real time, so ordering across
   *  backend-raised and harness-raised anomalies stays what it has always been. */
  anomaly: (text: string) => void;
}

export interface TurnOutcome {
  /** The tools-on assistant blocks, thinking already dropped. */
  assistantBlocks: Array<TextBlock | ToolUseBlock>;
  /** Every assistant text of the turn, joined — what the judge reads. */
  assistantText: string;
  toolCalls: TurnToolCall[];
  stopReason: string | null;
  /** null when the backend cannot report tokens (→ CaseResult.usageUnavailable). */
  usage: { inputTokens: number; outputTokens: number } | null;
  session?: SessionHandle;
}

export type RunTurn = (req: TurnRequest) => Promise<TurnOutcome>;

export interface Backend {
  readonly kind: BackendKind;
  runTurn: RunTurn;
  /** Released after each case — the SDK backend tears its session down here. */
  endCase?: () => void;
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
  /** 'builder' runs the builder-coach loop (draft reducer, single tool)
   *  instead of the sidebar loop. Defaults to the sidebar. */
  mode?: 'builder' | 'analytics';
  fixture: {
    /** builder mode: the starting draft (defaults to an empty draft on `today`). */
    draft?: { title?: string };
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
  /** builder mode only: the draft after every confirmed update. */
  finalDraft?: WorkoutDraft;
  /** analytics mode: the chart draft after the run. */
  finalChartDraft?: import('../../src/lib/analytics/draft').ChartDraft;
  anomalies: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** True when a turn ran on a backend that reported no tokens — the usage
   *  above is then a floor, not a measurement, and cost is not meaningful. */
  usageUnavailable?: boolean;
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
  /** Set when the backend reported no usage: costUsd is 0 because nothing was
   *  measured, not because the case was free. Readers must not average it in. */
  usageUnavailable?: boolean;
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
  /** Which backend drove the coach: 'api' is the Messages API, production-shaped
   *  and the nightly measurement of record; 'agent-sdk' drives Claude Code on a
   *  subscription and is a regression detector, not a production replica.
   *  Results written before this field existed do not carry it; readers fall
   *  back to 'api', which is what every one of them was. */
  backend: BackendKind;
  gitCommit: string;
  /** src/lib/coach/prompt.ts → PROMPT_VERSION: the hand-declared version of
   *  the prompt this run scored. Says whether an edit was MEANT to change
   *  behavior, where promptFileHash below says whether the bytes moved —
   *  the two disagreeing is an unbumped edit. Results written before this
   *  field existed do not carry it; readers fall back to 'unversioned'. */
  promptVersion: string;
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
