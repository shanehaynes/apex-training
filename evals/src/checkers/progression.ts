import { parseISO, startOfWeek, format } from 'date-fns';
import type { ExerciseDefinition, WorkoutEvent, Exercise } from '../../../src/types/workout';
import type { DimensionVerdict, EvalCase } from '../types';
import { patternsFor } from '../taxonomy';
import { parseReps, repVolume } from '../parsers/reps';

// Arithmetic progression check: fold the final schedule (fixture events plus
// everything the coach created) into per-week buckets from `today` forward and
// verify the curve — week-over-week increases within the threshold, drops only
// where a deload allows them (or monotone decrease for tapers).

interface WeekBucket {
  weekStart: string;
  value: number;
  notes: string[];
}

function exercisesOf(event: WorkoutEvent): Exercise[] {
  return [...(event.warmup ?? []), ...event.exercises, ...(event.cooldown ?? [])];
}

export function weeklyBuckets(
  evalCase: EvalCase,
  events: WorkoutEvent[],
  definitions: Iterable<ExerciseDefinition>,
): WeekBucket[] {
  const expect = evalCase.expect.progression;
  if (!expect) return [];
  const defs = [...definitions];
  const todayWeek = startOfWeek(parseISO(evalCase.fixture.today), { weekStartsOn: 1 });
  const buckets = new Map<string, WeekBucket>();

  const matchesPattern = (ex: Exercise): boolean => {
    if (!expect.pattern) return true;
    const patterns = patternsFor(ex.name, defs);
    return patterns !== null && patterns.includes(expect.pattern);
  };

  for (const event of events) {
    const date = parseISO(event.date);
    const weekStart = startOfWeek(date, { weekStartsOn: 1 });
    if (weekStart < todayWeek) continue;
    const key = format(weekStart, 'yyyy-MM-dd');
    const bucket = buckets.get(key) ?? { weekStart: key, value: 0, notes: [] };

    const relevant = exercisesOf(event).filter(matchesPattern);
    if (expect.metric === 'weeklyMinutes') {
      if (!expect.pattern || relevant.length > 0) bucket.value += event.estimatedDuration;
    } else {
      for (const ex of relevant) {
        const sets = ex.sets ?? (ex.reps || ex.duration ? 1 : 0);
        if (expect.metric === 'weeklySets') {
          bucket.value += sets;
        } else {
          const parsed = parseReps(ex.reps);
          const vol = repVolume(parsed);
          if (vol === null) {
            if (parsed.kind === 'unparseable' && ex.reps) {
              bucket.notes.push(`unparseable reps "${ex.reps}" on "${ex.name}" (${event.date})`);
            } else if (parsed.kind === 'amrap') {
              bucket.notes.push(`AMRAP reps on "${ex.name}" (${event.date}) — excluded from volume`);
            }
          } else {
            bucket.value += sets * vol;
          }
        }
      }
    }
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function checkProgression(
  evalCase: EvalCase,
  events: WorkoutEvent[],
  definitions: Iterable<ExerciseDefinition>,
): DimensionVerdict {
  const expect = evalCase.expect.progression;
  if (!expect) return { status: 'skipped', detail: [] };

  const all = weeklyBuckets(evalCase, events, definitions);
  // Trim leading/trailing empty weeks; interior zeros stay (they're real gaps).
  const first = all.findIndex(b => b.value > 0);
  const lastIdx = all.length - 1 - [...all].reverse().findIndex(b => b.value > 0);
  const buckets = first === -1 ? [] : all.slice(first, lastIdx + 1);

  const detail: string[] = buckets.map(b => `week ${b.weekStart}: ${expect.metric}=${Math.round(b.value * 10) / 10}`);
  for (const b of buckets) detail.push(...b.notes);

  if (buckets.length < 2) {
    detail.push('fewer than 2 non-empty weeks — no curve to check');
    return { status: 'fail', detail };
  }

  const direction = expect.direction ?? 'build';
  let deloadsUsed = 0;
  let failed = false;

  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1].value;
    const curr = buckets[i].value;
    const week = buckets[i].weekStart;
    if (prev === 0) {
      if (curr > 0) detail.push(`week ${week}: resumes after an empty week`);
      continue;
    }
    const changePct = ((curr - prev) / prev) * 100;

    if (direction === 'taper') {
      if (changePct > expect.maxWeekOverWeekIncreasePct) {
        detail.push(`TAPER VIOLATION: week ${week} increases ${changePct.toFixed(0)}% over prior week`);
        failed = true;
      }
      continue;
    }

    if (changePct > expect.maxWeekOverWeekIncreasePct) {
      detail.push(`RAMP VIOLATION: week ${week} jumps ${changePct.toFixed(0)}% (max ${expect.maxWeekOverWeekIncreasePct}%)`);
      failed = true;
    } else if (changePct < 0) {
      const dropPct = -changePct;
      if (expect.deload?.allowed && dropPct <= expect.deload.maxDropPct && deloadsUsed === 0) {
        deloadsUsed += 1;
        detail.push(`week ${week}: -${dropPct.toFixed(0)}% treated as deload`);
      } else if (expect.deload?.allowed) {
        detail.push(`DROP VIOLATION: week ${week} drops ${dropPct.toFixed(0)}% (${deloadsUsed > 0 ? 'deload already used' : `exceeds ${expect.deload.maxDropPct}% deload allowance`})`);
        failed = true;
      } else {
        detail.push(`DROP VIOLATION: week ${week} drops ${dropPct.toFixed(0)}% in a build with no deload allowance`);
        failed = true;
      }
    }
  }

  const hasUnparseable = buckets.some(b => b.notes.some(n => n.startsWith('unparseable')));
  if (failed) return { status: 'fail', detail };
  if (hasUnparseable) return { status: 'needs-taxonomy', detail: ['unparseable prescriptions kept this from being fully checked', ...detail] };
  return { status: 'pass', detail };
}
