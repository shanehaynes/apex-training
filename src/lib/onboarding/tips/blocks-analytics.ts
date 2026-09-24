import type { TipDefinition } from './types.js';

// Lane F07 (blocks + analytics) owns this file. Trigger sites:
// src/components/blocks/*, src/components/analytics/*.

export const BLOCKS_ANALYTICS_TIPS = [
  {
    id: 'blocks-first',
    title: 'Training blocks',
    body: 'A block is a few weeks with a weekly target, like “6 hours of cardio”. **New cycle** sets up several at once: three hard weeks, one easy.',
    priority: 1,
  },
  {
    id: 'analytics-first',
    title: 'Your charts',
    body: 'Charts of your own training, built by you. **New tile** picks what to measure — miles per week, weight lifted, hours trained.',
    priority: 1,
  },
  {
    id: 'tile-builder-first',
    title: 'Build a chart',
    body: 'Pick what to measure, then a chart type. Greyed choices do not fit what you already picked. The preview updates as you go.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
