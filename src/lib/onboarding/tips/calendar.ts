import type { TipDefinition } from './types.js';

// Lane O07 (calendar) owns this file. Trigger sites:
// - day-complete-circle: DayView (phone), MonthView and WeekView (desktop),
//   once the shown day or grid has a workout with a complete circle.
// - template-copied: Calendar, on the first mount after this device copied
//   the starter plan (hooks/useTemplateCopy.ts leaves the marker).

export const CALENDAR_TIPS = [
  {
    id: 'day-complete-circle',
    title: 'Mark a workout done',
    body: 'Tap the circle next to a workout to mark it done. Tap the circle again to undo. Tap the workout’s name to open it.',
    priority: 1,
  },
  {
    id: 'template-copied',
    title: 'Your plan is in',
    body: 'Tap any workout to see or change it. Shane’s workouts now repeat every week. To remove one, tap **Delete workout**, then **This day only** or **Whole series**.',
    help: 'repeating-workouts',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
