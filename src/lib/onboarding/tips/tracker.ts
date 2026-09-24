import type { TipDefinition } from './types.js';

// Lane F03 (tracker) owns this file. Trigger sites: src/components/tracker/*.

export const TRACKER_TIPS = [
  {
    id: 'tracker-first',
    title: 'Log as you go',
    body: 'Type what you actually did. It saves by itself. Press **Finish** when you are done — any records show at the end.',
    help: 'logging-a-workout',
    priority: 0,
  },
  {
    id: 'tracker-shadow',
    title: 'Grey numbers',
    body: 'Grey numbers are last time’s. Tap a box to keep them, or type over them.',
    help: 'logging-a-workout',
    priority: 0,
  },
  {
    id: 'tracker-unlogged',
    title: 'Blank sets',
    body: 'Sets you leave blank are saved as zero, so your history stays honest. **Keep going** to fill them, or finish anyway.',
    priority: 1,
  },
  {
    id: 'summary-first',
    title: 'Workout complete',
    body: 'Trophies are personal records. Your first time on a movement never counts — there is nothing to beat yet.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
