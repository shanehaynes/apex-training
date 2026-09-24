import type { TipDefinition } from './types.js';

// Lane O12 (library + meals) owns this file. Trigger sites:
// src/components/library/LibraryView.tsx (library-first, the list on screen),
// src/components/composer/AddMealView.tsx (meal-first, first open).
//
// Both screens start empty for a new user, so each tip says what fills them.

export const LIBRARY_MEALS_TIPS = [
  {
    id: 'library-first',
    title: 'Your exercise library',
    body: 'Find every exercise from your workouts here. The list grows as you add exercises or copy the starter plan. Tap one to see your best, your progress and **Recent sessions**.',
    priority: 2,
  },
  {
    id: 'meal-first',
    title: 'Add a meal',
    body: 'Type a title, then protein, carbs and fat in grams. Calories fill in from those. Tap **Save to library** and next time one tap fills this form.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
