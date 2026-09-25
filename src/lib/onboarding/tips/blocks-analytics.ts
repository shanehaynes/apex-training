import type { TipDefinition } from './types.js';

// Lane O13 (blocks + analytics) owns this file. Trigger sites:
//   blocks-first       — BlocksView, first mount
//   analytics-first    — AnalyticsView, first mount
//   tile-builder-first — TileBuilder for a new tile (tile === null), conditioned
// "Training block" and "tile" are the two most abstract ideas in the app, so
// each tip says what the thing IS in plain words, then names the button.

export const BLOCKS_ANALYTICS_TIPS = [
  {
    id: 'blocks-first',
    title: 'Train in blocks',
    body: 'Tap **New cycle** to plan several weeks at once. A cycle is blocks in a row, like three hard weeks, then one easy. Each block has a weekly goal, like 6 hours of cardio.',
    priority: 1,
  },
  {
    id: 'analytics-first',
    title: 'Chart your training',
    body: 'Tap **New tile** to add a chart of your own training. Pick what it counts, like miles each week or time spent training. Each chart is one tile on this page.',
    priority: 1,
  },
  {
    id: 'tile-builder-first',
    title: 'Build a chart',
    body: 'Pick a **Measure** — the thing your chart counts. Grey choices do not fit what you picked. The **Preview** redraws as you go. Tap **Save tile** when it looks right.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
