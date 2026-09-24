import type { TipDefinition } from './types.js';

// Lane O08 (workout detail) owns this file. Trigger sites:
//   workout-first-open   WorkoutModal, every mount (seen once per account)
//   workout-recurring    WorkoutModal, when the open event repeats — passes
//                        `when`, so it wins over workout-first-open
//   workout-sync-metrics SyncMetrics, once a watch row has arrived
// Labels quoted in bold are the on-screen ones in src/components/modal/*
// and src/components/builder/BuilderForm.tsx.

export const WORKOUT_TIPS = [
  {
    id: 'workout-first-open',
    title: 'Log it or change it',
    body: 'Press **Start Workout** to log each set as you go. **Mark as Complete** records it in one tap. To change the plan, use **Edit exercises** or **Edit workout**.',
    help: 'logging-a-workout',
    priority: 0,
  },
  {
    id: 'workout-recurring',
    title: 'This workout repeats',
    body: 'Pick your button with care, because this workout repeats. **Edit exercises** changes every day in the series. **Edit workout** and **Delete workout** ask first: one day, or the whole series?',
    help: 'repeating-workouts',
    priority: 0,
  },
  {
    id: 'workout-sync-metrics',
    title: 'From your watch',
    body: 'Compare what your watch measured with what you planned. Your planned targets stay as they were. The heart rate here also feeds the charts in **Analytics**.',
    help: 'connect-coros',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
