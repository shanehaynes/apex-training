import type { TipDefinition } from './types.js';

// Lane O11 (builder) owns this file. Trigger sites: src/components/builder/*
// — WorkoutBuilderView (search step), RepeatPicker (create mode),
// BuilderCoachPanel (the ✨ button). Bold labels match the screen.

export const BUILDER_TIPS = [
  {
    id: 'builder-search-first',
    title: 'Add a workout',
    body: 'Tap **Build a new workout** to plan this day. **Apply** adds it to your calendar and your library. Next time, find it here by name.',
    priority: 0,
  },
  {
    id: 'builder-repeat',
    title: 'Make it weekly',
    body: 'Turn **Repeat** on to put this on your calendar every week. Tap the days you train. Leave **Ends** on **Never** to keep it going.',
    help: 'repeating-workouts',
    priority: 0,
  },
  {
    id: 'builder-coach',
    title: 'Let the coach fill it',
    body: 'Describe the workout in your own words, like “20 minutes of rowing, then squats.” The coach fills the form. Only you can tap **Apply**. It uses your own key from Anthropic.',
    help: 'get-api-key',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
