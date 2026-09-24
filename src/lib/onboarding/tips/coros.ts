import type { TipDefinition } from './types.js';

// Lane F09 (COROS) owns this file. Trigger sites: src/components/sync/*,
// src/components/profile/CorosConnection.tsx. Every tip here is gated on the
// deployment having a watch provider configured (useProviderSync().configured).

export const COROS_TIPS = [
  {
    id: 'coros-connected',
    title: 'Watch linked',
    body: 'Press **Sync** above the calendar to bring in your activities. From now on it also happens by itself every night.',
    help: 'connect-coros',
    priority: 0,
  },
  {
    id: 'coros-fill-queue',
    title: 'Matches a plan',
    body: 'This watch activity looks like a planned workout. **Fill it** copies your real numbers into the plan. **Keep separate** adds it as its own event.',
    help: 'connect-coros',
    priority: 0,
  },
  {
    id: 'coros-expired',
    title: 'Link expired',
    body: 'Your watch link ran out. Press **Reconnect** and sign in to COROS again. Nothing already imported is lost.',
    help: 'connect-coros',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
