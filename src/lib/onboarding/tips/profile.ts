import type { TipDefinition } from './types.js';

// Lane F08 (profile) owns this file. Trigger sites: src/components/profile/*
// except ConnectorGuide*.tsx and CorosConnection.tsx (F09).

export const PROFILE_TIPS = [
  {
    id: 'coach-goal',
    title: 'Tell it your goal',
    body: 'Coach is on. Type one line under **Goal** — “run a 10k in March” — and every answer bends toward it.',
    priority: 1,
  },
  {
    id: 'calendar-feed',
    title: 'Your schedule elsewhere',
    body: 'Copy this address into Apple or Google Calendar and your workouts appear there. Treat it like a password — anyone with it can read your schedule.',
    help: 'calendar-feed',
    priority: 1,
  },
  {
    id: 'connector-first',
    title: 'Ask from Claude or ChatGPT',
    body: 'Let an assistant read your training. It can only look, never change anything. The guide button walks you through with pictures.',
    priority: 2,
  },
] as const satisfies readonly TipDefinition[];
