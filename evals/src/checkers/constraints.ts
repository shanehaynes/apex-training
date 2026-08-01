import type { ExerciseDefinition } from '../../../src/types/workout';
import type { DimensionVerdict, EvalCase, RecordedToolCall } from '../types';
import { patternsFor } from '../taxonomy';
import { parseWeight, externalLoadLb } from '../parsers/weight';

// Deterministic contraindication check: every exercise the coach proposed
// (create_event / set_event_exercises inputs) resolves through the movement
// taxonomy; intersection with the case's banned patterns is a failure.
// Unknown names fail closed as `needs-taxonomy` rather than passing silently.

interface ProposedExercise {
  name: string;
  weight?: string;
  source: string;
}

export function collectProposedExercises(toolCalls: RecordedToolCall[]): ProposedExercise[] {
  const out: ProposedExercise[] = [];
  for (const call of toolCalls) {
    if (call.name !== 'create_event' && call.name !== 'set_event_exercises') continue;
    const exercises = (call.input.exercises as Array<Record<string, unknown>> | undefined) ?? [];
    const label = call.name === 'create_event'
      ? `create_event "${String(call.input.title ?? '')}" ${String(call.input.date ?? '')}`
      : `set_event_exercises ${String(call.input.event_id ?? '')}`;
    for (const ex of exercises) {
      if (typeof ex.name !== 'string') continue;
      out.push({
        name: ex.name,
        weight: typeof ex.weight === 'string' ? ex.weight : undefined,
        source: label,
      });
    }
  }
  return out;
}

export function checkConstraints(
  evalCase: EvalCase,
  toolCalls: RecordedToolCall[],
  definitions: Iterable<ExerciseDefinition>,
): DimensionVerdict {
  const expect = evalCase.expect.constraints;
  if (!expect) return { status: 'skipped', detail: [] };

  const defs = [...definitions];
  const scoped = expect.fromTurn ? toolCalls.filter(c => c.turn >= expect.fromTurn!) : toolCalls;
  const proposed = collectProposedExercises(scoped);
  const detail: string[] = [];
  let unknown = 0;

  for (const ex of proposed) {
    const patterns = patternsFor(ex.name, defs);
    if (patterns === null) {
      unknown += 1;
      detail.push(`needs-taxonomy: "${ex.name}" (${ex.source}) — add it to movement-patterns.json`);
      continue;
    }

    const banned = patterns.filter(p => expect.bannedPatterns.includes(p));
    if (banned.length) {
      detail.push(`VIOLATION: "${ex.name}" carries banned pattern(s) [${banned.join(', ')}] (${ex.source})`);
    }

    for (const cap of expect.loadCaps ?? []) {
      if (!patterns.includes(cap.pattern)) continue;
      if (!ex.weight) continue;
      const load = externalLoadLb(parseWeight(ex.weight));
      if (load === null) {
        detail.push(`UNPARSEABLE WEIGHT on capped pattern "${cap.pattern}": "${ex.name}" weight "${ex.weight}" (${ex.source})`);
      } else if (load > cap.maxLb) {
        detail.push(`LOAD CAP VIOLATION: "${ex.name}" at ${load.toFixed(0)}lb exceeds ${cap.maxLb}lb cap on "${cap.pattern}" (${ex.source})`);
      }
    }
  }

  const hasViolation = detail.some(d => d.startsWith('VIOLATION') || d.startsWith('LOAD CAP') || d.startsWith('UNPARSEABLE WEIGHT'));
  if (hasViolation) return { status: 'fail', detail };
  if (unknown > 0) return { status: 'needs-taxonomy', detail };
  return { status: 'pass', detail };
}
