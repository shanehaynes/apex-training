import { addWeeks, format, parseISO, startOfWeek, subWeeks } from 'date-fns';
import { READ_DOCTRINE_TOOL } from '../../../src/lib/coach/tools';
import type { WorkoutEvent } from '../../../src/types/workout';
import type { DimensionVerdict, EvalCase, HarnessResult, RecordedToolCall } from '../types';

// Deterministic doctrine checks: what the coach wrote onto the calendar,
// read against the rules its own doctrine states outright. Each check is
// arithmetic or a regex over recorded tool calls — the doctrine says "no
// intensity in base", "muscular endurance after max strength, not before",
// "the taper cuts volume", and each of those is checkable without a judge.
// Whether an ANSWER grounds itself in doctrine is the one fuzzy question,
// and that goes to judge/doctrine.ts.

const EVENT_WRITE_TOOLS = new Set(['create_event', 'update_event', 'set_event_exercises']);

/** An event write's input with the event-level description removed —
 *  create_event carries it at the top, update_event under `changes`. */
function withoutDescription(input: Record<string, unknown>): Record<string, unknown> {
  const { description: _description, ...rest } = input;
  if (rest.changes && typeof rest.changes === 'object') {
    const { description: _changed, ...changes } = rest.changes as Record<string, unknown>;
    return { ...rest, changes };
  }
  return rest;
}

/** Every event-writing call's input as one JSON string, with its label. */
export function eventWrites(
  toolCalls: RecordedToolCall[],
  { skipDescription = false }: { skipDescription?: boolean } = {},
): Array<{ label: string; json: string }> {
  return toolCalls
    .filter(c => EVENT_WRITE_TOOLS.has(c.name))
    .map(c => ({
      label: c.name === 'create_event'
        ? `create_event "${String(c.input.title ?? '')}" ${String(c.input.date ?? '')}`
        : `${c.name} ${String(c.input.event_id ?? '')}`,
      json: JSON.stringify(skipDescription ? withoutDescription(c.input) : c.input),
    }));
}

const WEEK = { weekStartsOn: 1 } as const;

/** Planned minutes per Monday-start week, for the week holding `today` and the one before. */
export function weekMinutes(events: WorkoutEvent[], today: string): { prior: number; current: number; priorStart: string; currentStart: string } {
  const currentStart = startOfWeek(parseISO(today), WEEK);
  const priorStart = subWeeks(currentStart, 1);
  const nextStart = addWeeks(currentStart, 1);
  let prior = 0;
  let current = 0;
  for (const e of events) {
    const d = parseISO(e.date);
    if (d >= priorStart && d < currentStart) prior += e.estimatedDuration;
    else if (d >= currentStart && d < nextStart) current += e.estimatedDuration;
  }
  return { prior, current, priorStart: format(priorStart, 'yyyy-MM-dd'), currentStart: format(currentStart, 'yyyy-MM-dd') };
}

export function checkDoctrine(evalCase: EvalCase, result: HarnessResult): DimensionVerdict {
  const expect = evalCase.expect.doctrine;
  if (!expect) return { status: 'skipped', detail: [] };

  const detail: string[] = [];
  let failed = false;

  if (expect.bannedEventPatterns) {
    const patterns = expect.bannedEventPatterns.map(p => new RegExp(p, 'i'));
    const writes = eventWrites(result.toolCalls, { skipDescription: expect.bannedEventPatternsSkipDescription });
    for (const write of writes) {
      for (const pattern of patterns) {
        const hit = write.json.match(pattern);
        if (hit) {
          detail.push(`BANNED PATTERN: /${pattern.source}/ matched "${hit[0]}" in ${write.label}`);
          failed = true;
        }
      }
    }
    detail.push(`${writes.length} event write(s) checked against ${patterns.length} banned pattern(s)`);
  }

  if (expect.requireDoctrineRead) {
    const { topics, beforeFirstWrite } = expect.requireDoctrineRead;
    const reads = result.toolCalls.filter(c => c.name === READ_DOCTRINE_TOOL);
    const wanted = topics?.length
      ? reads.filter(c => topics.includes(String(c.input.topic)))
      : reads;
    if (!wanted.length) {
      detail.push(`MISSING DOCTRINE READ: expected read_doctrine${topics?.length ? ` on ${topics.join(' or ')}` : ''}` +
        (reads.length ? ` — read ${reads.map(c => String(c.input.topic)).join(', ')} instead` : ' — the coach never read the doctrine'));
      failed = true;
    } else {
      detail.push(`read doctrine: ${wanted.map(c => String(c.input.topic)).join(', ')}`);
      if (beforeFirstWrite) {
        // "Before" means an EARLIER MODEL RESPONSE, not an earlier index: the
        // backend runs a response's reads ahead of its writes, so a read and a
        // write asked for together are recorded read-first although the model
        // composed the prescription without the doctrine in hand. Rounds
        // settle it when both are recorded; index order is the fallback for a
        // record without them.
        const firstRead = wanted[0];
        const firstWrite = result.toolCalls.find(c => c.kind !== 'read');
        if (firstWrite) {
          const haveRounds = firstRead.round !== undefined && firstWrite.round !== undefined;
          if (haveRounds && firstWrite.round === firstRead.round) {
            detail.push(`PRESCRIBED ALONGSIDE READING: "${firstWrite.name}" was asked for in the same model response as the first doctrine read`);
            failed = true;
          } else if (haveRounds ? firstWrite.round! < firstRead.round! : result.toolCalls.indexOf(firstWrite) < result.toolCalls.indexOf(firstRead)) {
            detail.push(`PRESCRIBED BEFORE READING: "${firstWrite.name}" ran before the first doctrine read`);
            failed = true;
          }
        }
      }
    }
  }

  if (expect.taperBelowPriorWeek) {
    const { prior, current, priorStart, currentStart } = weekMinutes(result.finalEvents, evalCase.fixture.today);
    detail.push(`week of ${priorStart}: ${prior} min · week of ${currentStart}: ${current} min planned`);
    if (current === 0) {
      detail.push('NOTHING PLANNED: the taper week holds no sessions');
      failed = true;
    } else if (prior === 0) {
      detail.push('NO PRIOR WEEK: the fixture gives the taper nothing to be below');
      failed = true;
    } else if (current >= prior) {
      detail.push(`TAPER VIOLATION: ${current} min planned is not below the prior week's ${prior} min`);
      failed = true;
    }
  }

  return { status: failed ? 'fail' : 'pass', detail };
}
