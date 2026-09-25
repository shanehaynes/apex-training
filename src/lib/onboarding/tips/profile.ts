import type { TipDefinition } from './types.js';

// Lane O14 (profile) owns this file. Trigger sites: src/components/profile/*
// except ConnectorGuide*.tsx and CorosConnection.tsx (O15).

export const PROFILE_TIPS = [
  {
    // ProfileView: a key save just succeeded (none → saved) and Goal is empty.
    id: 'coach-goal',
    title: 'Tell the coach your goal',
    body: 'Type what you are training for under **Goal**, like “run a 10k in March.” The coach shapes every answer around it.',
    priority: 1,
  },
  {
    // ProfileView: the Calendar feed fold, opened from its header.
    id: 'calendar-feed',
    title: 'Workouts in your calendar',
    body: 'Copy this address into Apple or Google Calendar. Your workouts show up there, and changes follow within a few hours. Keep it private: anyone with it can read your schedule.',
    help: 'calendar-feed',
    priority: 1,
  },
  {
    // McpTokens: the Claude or ChatGPT fold, opened from its header.
    id: 'connector-first',
    title: 'Ask Claude or ChatGPT',
    body: 'Connect Claude or ChatGPT so it can answer questions about your training. It can look but never change anything. Tap **Step-by-step guide** for pictures of each step.',
    priority: 2,
  },
] as const satisfies readonly TipDefinition[];
