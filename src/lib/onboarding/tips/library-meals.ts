import type { TipDefinition } from './types.js';

// Lane F06 (library + meals) owns this file. Trigger sites:
// src/components/library/*, src/components/composer/*.

export const LIBRARY_MEALS_TIPS = [
  {
    id: 'library-first',
    title: 'Your exercises',
    body: 'Every movement you have logged lives here. Open one for your best, a chart over time, and recent sessions.',
    priority: 2,
  },
  {
    id: 'meal-first',
    title: 'Add a meal',
    body: 'Type protein, carbs and fat in grams; calories fill in by themselves. **Save to library** to re-add this meal in one tap later.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
