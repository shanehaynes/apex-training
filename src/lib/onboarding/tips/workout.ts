import type { TipDefinition } from './types.js';

// Lane F02 (workout detail) owns this file. Trigger sites:
// src/components/modal/* except DayModal.tsx.

export const WORKOUT_TIPS = [
  {
    id: 'workout-first-open',
    title: 'This workout',
    body: '**Start Workout** logs it set by set. **Mark as Complete** ticks it without logging. **Edit exercises** or **Edit workout** change the plan.',
    help: 'logging-a-workout',
    priority: 0,
  },
  {
    id: 'workout-recurring',
    title: 'It repeats',
    body: 'This workout repeats weekly. **Edit exercises** changes every week. **Edit workout** and **Delete workout** ask: this day only, or the whole series?',
    help: 'repeating-workouts',
    priority: 0,
  },
  {
    id: 'workout-sync-metrics',
    title: 'From your watch',
    body: 'These numbers came from your watch. Your planned targets stay; what you actually did sits beside them and counts toward records.',
    help: 'connect-coros',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
