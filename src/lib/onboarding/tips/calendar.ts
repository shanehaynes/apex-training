import type { TipDefinition } from './types.js';

// Lane F01 (calendar) owns this file. Trigger sites: src/components/calendar/*,
// modal/DayModal.tsx, hooks/useTemplateCopy.ts.

export const CALENDAR_TIPS = [
  {
    id: 'day-complete-circle',
    title: 'Two ways to tap',
    body: 'Tap a workout to open it. The circle on the right marks it done without opening — handy for a walk you already took.',
    priority: 1,
  },
  {
    id: 'template-copied',
    title: 'Your plan is in',
    body: 'Shane’s workouts now repeat every week. Open one to change or delete that one day, or the whole series.',
    help: 'repeating-workouts',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
