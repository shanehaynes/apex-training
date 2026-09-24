import type { TipDefinition } from './types.js';

// Lane O10 (coach) owns this file. Trigger sites: src/components/sidebar/*,
// src/components/coach/*.
//
// coach-first-message → ChatSidebar: a key is saved, the thread is empty, and
//   the pane is on screen (desktop rail on load; phone Coach tab opened).
// coach-confirm-card  → ChatSidebar's ConfirmCard: first pending action.

export const COACH_TIPS = [
  {
    id: 'coach-first-message',
    title: 'Ask your coach',
    body: 'Type a question in plain words, like “what’s on this week?” Press **Coach’s Notes** for a daily briefing. It never changes your plan without asking you first.',
    priority: 0,
  },
  {
    id: 'coach-confirm-card',
    title: 'It asks first',
    body: 'Press **Confirm** to make this change, or **Cancel** to skip it. Nothing changes until you choose. **Coach activity** in Profile lists everything the coach has done.',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
