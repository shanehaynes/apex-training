import type { TipDefinition } from './types.js';

// Lane F04 (coach) owns this file. Trigger sites: src/components/sidebar/*,
// src/components/coach/*.

export const COACH_TIPS = [
  {
    id: 'coach-first-message',
    title: 'Ask anything',
    body: 'Ask in plain words — “what’s on this week?” **Coach’s Notes** gives a daily briefing. When it wants to change something, it asks you first.',
    priority: 0,
  },
  {
    id: 'coach-confirm-card',
    title: 'It asks first',
    body: 'The coach wants to change your calendar. Nothing happens until you press **Confirm**. Profile → Activity keeps a log of everything it did.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
