import type Anthropic from '@anthropic-ai/sdk';
import { readToolSchemas } from '../../api/_lib/coach/readTools';
import { coachToolSchemas } from '../../src/lib/coach/schemas';
import { isServerSideTool, READ_DOCTRINE_TOOL } from '../../src/lib/coach/tools';
import { DOCTRINE_TOPICS, readDoctrine, readDoctrineToolSchema } from '../../src/lib/coach/doctrine/index';

// The sight loop's server side, as the harness runs it (api/chat.ts, "THE
// SIGHT LOOP"). Production answers the read tools from Supabase through
// executeReadTool and read_doctrine from the doctrine module; the harness
// has no database, so a case scripts what each read "returns" in its
// fixture (EvalCase.fixture.reads) and read_doctrine is answered from the
// real doctrine text — the one part of the sight loop that IS pure.
//
// The two constants below are MIRRORS of api/chat.ts, not imports: the
// harness's runtime graph stays clear of the Vercel handler and its auth /
// Supabase / rate-limit modules. __tests__/reads.test.ts imports api/chat.ts
// and pins both, so a production change fails a test here rather than
// silently measuring a different coach.

/** api/chat.ts → MAX_SERVER_ROUNDS: read-only rounds one user turn may run. */
export const MAX_SERVER_ROUNDS = 5;

/**
 * The chat coach's tool list in production order (api/chat.ts →
 * chatToolSchemas): the ten write tools (the eight calendar/meal writes,
 * then propose_contract_edit and leave_note from lane D01), the read tools,
 * read_doctrine.
 *
 * Production's list ends with one more entry the harness deliberately does
 * NOT offer: the typed `memory_20250818` tool (lane C02). It has no
 * input_schema of ours to wrap for the Agent SDK backend and no fixture
 * backend here — a `memory view` would always read as empty and a write would
 * always be refused — so offering it would measure a coach talking to a stub.
 * MEMORY_TOOL_OMITTED names the gap; __tests__/reads.test.ts pins that it is
 * the ONLY difference from production, so any other new tool still fails the
 * mirror. Fixture-backed memory is a follow-up (docs/coach/STATUS.md).
 */
export const MEMORY_TOOL_OMITTED = 'memory';

export function chatToolSchemas(): Anthropic.Tool[] {
  return [...coachToolSchemas(), ...readToolSchemas(), { ...readDoctrineToolSchema }];
}

/** A read tool's scripted answer computed from the call's input. */
export type ReadScript = (input: Record<string, unknown>) => unknown;

/** A read tool's scripted answer: a JSON-able value, or a ReadScript. (Spelled
 *  out rather than `unknown | ReadScript`, which collapses to `unknown` and
 *  leaves a script's parameter untyped in the case files.) */
export type ScriptedRead = ReadScript | object | string | number | boolean | null;

/** EvalCase.fixture.reads — keyed by read-tool name. */
export type ReadFixture = Record<string, ScriptedRead>;

/**
 * What a read the fixture did not script returns. One fixed shape, chosen to
 * be honest rather than plausible: the model is told there is nothing, never
 * handed invented numbers it could cite. The harness also records an
 * `unscriptedRead:<name>` anomaly, so a case whose coach reached for data
 * the author did not anticipate is visible in the run table.
 */
export const UNSCRIPTED_READ_RESULT = { note: 'no data for this athlete' } as const;

/** Mirrors api/chat.ts → ServerToolOutcome, minus the wire-only fields. */
export interface ServerToolResult {
  /** The tool_result text — JSON as executeReadTool would produce it, or the doctrine topic text. */
  text: string;
  /** The structured tool_result content when it is not plain text: the
   *  doctrine's citable document block. Absent for every read tool. */
  content?: Exclude<Anthropic.ToolResultBlockParam['content'], string | undefined>;
  isError: boolean;
}

function topicOf(input: unknown): string | undefined {
  const topic = typeof input === 'object' && input !== null ? (input as { topic?: unknown }).topic : undefined;
  return typeof topic === 'string' ? topic : undefined;
}

/**
 * Run one server-side tool the way api/chat.ts → runServerSideTool does,
 * against the fixture instead of a database. Never throws: a function-valued
 * script that throws becomes an error result the model can read, as a
 * ToolInputError would in production.
 *
 * Only ever called for a name isServerSideTool() accepts; a write tool here
 * is a harness bug, and says so.
 */
export function executeServerSideTool(
  name: string,
  input: Record<string, unknown>,
  reads: ReadFixture | undefined,
  anomaly: (text: string) => void,
): ServerToolResult {
  if (name === READ_DOCTRINE_TOOL) {
    const topic = topicOf(input);
    const text = topic === undefined ? null : readDoctrine(topic);
    if (text === null) {
      return { text: `Unknown doctrine topic: ${String(topic)}`, isError: true };
    }
    const title = DOCTRINE_TOPICS.find(t => t.id === topic)?.title ?? (topic as string);
    return {
      text,
      content: [{
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: text },
        title,
        citations: { enabled: true },
      }],
      isError: false,
    };
  }
  if (!isServerSideTool(name)) {
    return { text: `Unknown tool: ${name}`, isError: true };
  }
  if (!reads || !(name in reads)) {
    anomaly(`unscriptedRead:${name}`);
    return { text: JSON.stringify(UNSCRIPTED_READ_RESULT), isError: false };
  }
  const script = reads[name];
  try {
    const payload = typeof script === 'function'
      ? (script as (input: Record<string, unknown>) => unknown)(input)
      : script;
    return { text: JSON.stringify(payload), isError: false };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}
