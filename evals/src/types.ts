import type { ExerciseDefinition, WorkoutEvent } from '../../src/types/workout';
import type { Meal } from '../../src/types/nutrition';
import type { WorkoutDraft } from '../../src/lib/builder/draft';
import type { BlockDraft } from '../../src/lib/blocks/draft';
import type { BlockPromptSummary } from '../../src/lib/blocks/promptSummary';
import type { Objective, TrainingBlock } from '../../src/types/blocks';
import type { ApiMessage, TextBlock, ToolResultBlock } from '../../src/lib/coach/actionQueue';
import type { WireToolUse } from '../../src/lib/coach/wire';
import type { PhysiologyInputs } from '../../src/lib/physiology/index';
import type { ReadFixture, ServerToolResult } from './reads';

// Core types for the coach eval harness. The harness mirrors api/chat.ts +
// useChat.ts + actionQueue.ts: a response asking only for server-side tools
// (the read tools, read_doctrine) is answered in the same turn and the model
// is called again with tools on, up to MAX_SERVER_ROUNDS times; every write
// tool_use is confirmed in order, the results flush as ONE tool_result user
// message (a mixed round's read results folded in ahead of them), tools are
// disabled on the post-confirm re-stream, and thinking blocks are dropped
// from history.

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
  /** Scoped tool lists (api/chat.ts toolMode). */
  toolMode?: 'chat' | 'builder' | 'analytics' | 'planner';
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

/** How a recorded call reached the fixture: a confirmed write through the
 *  coach tool executors, or a server-side read answered from the fixture
 *  (or, for read_doctrine, from the real doctrine text). */
export type ToolCallKind = 'write' | 'read';

/** One tool the turn actually executed, against the harness's in-memory deps. */
export interface TurnToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The tool_result string, byte-identical to what production would produce. */
  resultText: string;
  kind: ToolCallKind;
  /** Which model response of the turn asked for this call, from 0. Two calls
   *  with the same round were requested in one response — the model composed
   *  them together, so neither could have informed the other. */
  round: number;
}

/** Runs one server-side tool (isServerSideTool) against the fixture. */
export type ExecuteRead = (name: string, input: Record<string, unknown>) => Promise<ServerToolResult>;

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
  /** Runs one server-side tool against the fixture. Present in chat and
   *  planner mode only: the builder and analytics lists carry no read
   *  tools, and without it a backend treats every tool_use as a write,
   *  exactly as before the sight loop existed. */
  executeRead?: ExecuteRead;
  /** Scoped tool lists (api/chat.ts toolMode); absent for the sidebar. */
  toolMode?: 'builder' | 'analytics' | 'planner';
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
   *  instead of the sidebar loop; 'analytics' the chart reducer; 'planner'
   *  (E01) the block-draft reducer plus the read tools. Defaults to the sidebar. */
  mode?: 'builder' | 'analytics' | 'planner';
  fixture: {
    /** builder mode: the starting draft (defaults to an empty draft on `today`). */
    draft?: { title?: string };
    /** planner mode: the starting block draft (defaults to an empty one). */
    blockDraft?: BlockDraft;
    /** planner mode: the athlete's existing blocks — the reducer's overlap
     *  rule and the prompt's <existing_blocks>. Defaults to none. */
    existingBlocks?: TrainingBlock[];
    /** planner mode: the athlete's objectives — objective_id must name one. Defaults to none. */
    objectives?: Objective[];
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
    /** What each read tool returns, keyed by tool name: a value, or a function
     *  of the call's input; JSON-stringified as executeReadTool would. A read
     *  the fixture does not script returns UNSCRIPTED_READ_RESULT and records
     *  an `unscriptedRead:<name>` anomaly. read_doctrine is never scripted —
     *  it reads the real doctrine text. */
    reads?: ReadFixture;
    /** Measured data for the prompt's <physiology> panel (src/lib/physiology).
     *  `today` inside it is overridden by the fixture's own — one clock per
     *  case. Absent: the panel renders nothing, as it does for an athlete with
     *  no synced or logged data. */
    physiology?: PhysiologyInputs;
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
      /** Fail unless a call of this name — any of these names, given a list —
       *  ran (optionally matching input keys / result text). Reads count:
       *  a case can require the coach to have looked before it answered. */
      requireToolCall?: {
        name: string | string[];
        inputMatches?: Record<string, unknown>;
        resultIncludes?: string;
      };
      /** Fail if any of these tools were called at all. */
      forbidToolCalls?: string[];
      /** Fail if the fixture's events differ after the run from what the case
       *  started with — the proof that a turn of reads mutated nothing. */
      fixtureUnchanged?: true;
    };
    doctrine?: {
      /** Regex sources; fail if any matches the JSON of a create_event,
       *  update_event or set_event_exercises input (titles, descriptions,
       *  tags, exercise names and notes — anything the coach wrote onto the
       *  calendar). Case-insensitive. */
      bannedEventPatterns?: string[];
      /** Leave the event's free-text description out of the banned-pattern
       *  check, for cases whose prescription lives in the title and
       *  exercises: a coach explaining which work it is deferring ("no pack
       *  yet — loaded step-ups come later") is not prescribing it. Cardio
       *  cases keep the description, because that is where a run's
       *  intervals are written. */
      bannedEventPatternsSkipDescription?: true;
      /** Fail unless read_doctrine ran — with one of `topics` when given, and
       *  before the first write tool call when `beforeFirstWrite` is set. */
      requireDoctrineRead?: { topics?: string[]; beforeFirstWrite?: boolean };
      /** Fail unless the minutes planned in today's week (fixture events plus
       *  everything the coach created) are below the prior week's, and
       *  something was planned at all. */
      taperBelowPriorWeek?: true;
      /** Judge-scored: does the answer ground itself in the doctrine it read? */
      citesDoctrine?: { rubric: string };
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
  /** 'read' for a server-side tool answered from the fixture, 'write' for a
   *  confirmed coach tool. Optional so a record written before the sight
   *  loop still reads; a missing value is a write, which is all there were. */
  kind?: ToolCallKind;
  /** The model response (0-based, within the turn) that asked for this call;
   *  see TurnToolCall.round. Optional for the same reason as `kind`. */
  round?: number;
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
  /** planner mode: the block draft after every applied update. */
  finalBlockDraft?: BlockDraft;
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
    doctrine?: DimensionVerdict;
  };
  turns: number;
  /** Every recorded call, reads included. */
  toolCallCount: number;
  /** The reads among them. Absent on results written before the sight loop,
   *  which had none; readers fall back to 0. */
  readCallCount?: number;
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
