import type { TipDefinition } from './types.js';

// Lane O09 (tracker) owns this file. Trigger sites: src/components/tracker/*
// — tracker-first and tracker-shadow in TrackerView (TrackerTips),
// tracker-unlogged in ConfirmBar (the unlogged-sets bar only), summary-first
// in WorkoutSummary. Labels named here are the on-screen ones: Finish (the
// tracker header), Keep going / Finish anyway (ConfirmBar).

export const TRACKER_TIPS = [
  {
    id: 'tracker-first',
    title: 'Log as you go',
    body: 'Type what you actually did in each box. It saves as you type. Tap **Finish** at the top when you are done.',
    help: 'logging-a-workout',
    priority: 0,
  },
  {
    id: 'tracker-shadow',
    title: 'Grey means last time',
    body: 'Tap a grey number to keep last time’s set. Type over it to change it. Grey numbers are not saved until you tap them.',
    help: 'logging-a-workout',
    priority: 0,
  },
  {
    id: 'tracker-unlogged',
    title: 'Blank sets',
    body: 'Tap **Keep going** to fill in the blank sets. **Finish anyway** saves them as zero, marked skipped.',
    priority: 1,
  },
  {
    id: 'summary-first',
    title: 'What trophies mean',
    body: 'Look for a trophy: it marks a personal record. A first try at a movement has nothing to beat yet. You can still edit this workout later.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
