import { describe, it, expect } from 'vitest';
import { chatToolSchemas as productionChatToolSchemas, MAX_SERVER_ROUNDS as PRODUCTION_MAX_SERVER_ROUNDS } from '../../api/chat';
import { readDoctrine, DOCTRINE_TOPICS } from '../../src/lib/coach/doctrine/index';
import { SERVER_SIDE_READ_TOOL_NAMES } from '../../src/lib/coach/tools';
import { coachToolSchemas } from '../../src/lib/coach/schemas';
import { chatToolSchemas, executeServerSideTool, MAX_SERVER_ROUNDS, MEMORY_TOOL_OMITTED, UNSCRIPTED_READ_RESULT } from '../src/reads';
import { schemasFor, zodShapeFromJsonSchema } from '../src/backends/agentSdk';

// reads.ts mirrors two production values instead of importing them, so the
// harness's runtime graph never touches the Vercel handler. This file is
// where the mirror is pinned: it DOES import api/chat.ts, and a production
// change fails here rather than silently measuring a different coach.

describe('mirrors of api/chat.ts', () => {
  it('pins MAX_SERVER_ROUNDS to production', () => {
    expect(MAX_SERVER_ROUNDS).toBe(PRODUCTION_MAX_SERVER_ROUNDS);
  });

  it('offers the production chat tool list, in production order, minus the one tool it cannot back', () => {
    const names = chatToolSchemas().map(t => t.name);
    const production = productionChatToolSchemas().map(t => t.name);
    // The typed memory tool is the ONE deliberate omission (see reads.ts); a
    // production list that differs in any other way fails here.
    expect(production.filter(n => n !== MEMORY_TOOL_OMITTED)).toEqual(names);
    expect(production.filter(n => !names.includes(n))).toEqual([MEMORY_TOOL_OMITTED]);
    // The ten writes, then every read tool in its fixed order, then read_doctrine.
    expect(names.slice(-1)).toEqual(['read_doctrine']);
    expect(names.slice(0, 10)).toEqual(coachToolSchemas().map(t => t.name));
    expect(names.slice(10, -1)).toEqual([...SERVER_SIDE_READ_TOOL_NAMES]);
    // The agent-sdk backend hands the SDK the same list.
    expect(schemasFor().map(t => t.name)).toEqual(names);
  });

  it('returns fresh schema objects each call, so a caller cannot mutate the list', () => {
    const a = chatToolSchemas();
    const b = chatToolSchemas();
    expect(a).not.toBe(b);
    expect(a[a.length - 1]).not.toBe(b[b.length - 1]);
    expect(a).toEqual(b);
  });

  it('converts every read schema to a Zod shape, so the SDK backend can register them', () => {
    for (const schema of chatToolSchemas()) {
      const shape = zodShapeFromJsonSchema(schema.input_schema);
      const declared = Object.keys(
        (schema.input_schema as { properties: Record<string, unknown> }).properties);
      expect(Object.keys(shape).sort(), schema.name).toEqual(declared.sort());
    }
  });
});

describe('executeServerSideTool', () => {
  const noAnomaly = () => { throw new Error('unexpected anomaly'); };

  it('answers a scripted read with the JSON of its value', () => {
    const out = executeServerSideTool('get_prs', {}, { get_prs: { records: [{ exercise: 'Deadlift', value: 356 }] } }, noAnomaly);
    expect(out).toEqual({ text: '{"records":[{"exercise":"Deadlift","value":356}]}', isError: false });
  });

  it('answers a function-valued script from the call input', () => {
    const reads = { get_period_stats: (input: Record<string, unknown>) => ({ month: input.month, minutes: 195 }) };
    const out = executeServerSideTool('get_period_stats', { period_type: 'month', year: 2026, month: 8 }, reads, noAnomaly);
    expect(JSON.parse(out.text)).toEqual({ month: 8, minutes: 195 });
    expect(out.isError).toBe(false);
  });

  it('turns a throwing script into an error result the model can read', () => {
    const reads = { get_exercise_history: () => { throw new Error('No logged history for "Curl".'); } };
    const out = executeServerSideTool('get_exercise_history', { exercise_name: 'Curl' }, reads, noAnomaly);
    expect(out).toEqual({ text: 'No logged history for "Curl".', isError: true });
  });

  it('answers an unscripted read honestly and records the anomaly', () => {
    const anomalies: string[] = [];
    const out = executeServerSideTool('get_meals', { start_date: '2026-08-01', end_date: '2026-08-03' }, {}, a => anomalies.push(a));
    expect(out).toEqual({ text: JSON.stringify(UNSCRIPTED_READ_RESULT), isError: false });
    expect(JSON.parse(out.text)).toEqual({ note: 'no data for this athlete' });
    expect(anomalies).toEqual(['unscriptedRead:get_meals']);
    // No fixture at all is the same as a fixture that does not script it.
    expect(executeServerSideTool('get_meals', {}, undefined, () => {}).text).toBe(out.text);
  });

  it('answers read_doctrine from the real topic text, as a citable document', () => {
    const out = executeServerSideTool('read_doctrine', { topic: 'aerobic-base' }, {}, noAnomaly);
    const text = readDoctrine('aerobic-base')!;
    expect(out.isError).toBe(false);
    expect(out.text).toBe(text);
    expect(out.content).toEqual([{
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: text },
      title: DOCTRINE_TOPICS.find(t => t.id === 'aerobic-base')!.title,
      citations: { enabled: true },
    }]);
  });

  it('never scripts read_doctrine — the fixture cannot override the doctrine', () => {
    const out = executeServerSideTool('read_doctrine', { topic: 'strength' }, { read_doctrine: 'lift heavy, bro' }, noAnomaly);
    expect(out.text).toBe(readDoctrine('strength'));
  });

  it('answers an unknown doctrine topic with an error result, like production', () => {
    const out = executeServerSideTool('read_doctrine', { topic: 'crossfit' }, {}, noAnomaly);
    expect(out).toEqual({ text: 'Unknown doctrine topic: crossfit', isError: true });
    expect(executeServerSideTool('read_doctrine', {}, {}, noAnomaly).isError).toBe(true);
  });

  it('refuses a write tool — that is a harness bug, not a read', () => {
    const out = executeServerSideTool('create_event', { title: 'x' }, { create_event: {} }, noAnomaly);
    expect(out).toEqual({ text: 'Unknown tool: create_event', isError: true });
  });
});
