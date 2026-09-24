import type { TipDefinition } from './types.js';

// Lane F05 (builder) owns this file. Trigger sites: src/components/builder/*.

export const BUILDER_TIPS = [
  {
    id: 'builder-search-first',
    title: 'Add a workout',
    body: 'Pick a saved workout to put it on this day, or build a new one. **Apply** saves it to your library for next time.',
    priority: 0,
  },
  {
    id: 'builder-repeat',
    title: 'Make it weekly',
    body: 'Turn **Repeat** on to schedule this every week. Pick the days. **Ends: Never** keeps it going until you delete it.',
    help: 'repeating-workouts',
    priority: 0,
  },
  {
    id: 'builder-coach',
    title: 'Say it, don’t type it',
    body: 'Describe the workout in words — “20 minutes of rowing then squats” — and the coach fills the form for you. Needs your Anthropic key.',
    help: 'get-api-key',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
