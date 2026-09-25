import type { TipDefinition } from './types.js';

// Lane O15 (COROS) owns this file. Trigger sites: src/components/sync/
// ProviderSyncControls.tsx (all three) and src/components/profile/
// CorosConnection.tsx (coros-expired). Every tip here is gated on the
// deployment having a watch provider configured (useProviderSync().configured).
//
// The Sync / Reconnect nav button shows only its icon on a phone, so the
// copy names the icon as well as the label.

export const COROS_TIPS = [
  {
    id: 'coros-connected',
    title: 'Your watch is linked',
    body: 'Tap **Sync** — the circling arrows at the top — to bring in your runs and rides. After that, Apex brings them in by itself every night.',
    help: 'connect-coros',
    priority: 0,
  },
  {
    id: 'coros-fill-queue',
    title: 'Matches your plan',
    body: 'Tap **Fill it** to add this watch activity to the workout you planned. Tap **Keep separate** to save it as its own workout. Your plan stays as written.',
    help: 'connect-coros',
    priority: 0,
  },
  {
    id: 'coros-expired',
    title: 'Watch link expired',
    body: 'Tap **Reconnect**, then **Reconnect COROS**, to sign in again. On a phone, **Reconnect** is the circling arrows at the top. Nothing you brought in is lost.',
    help: 'connect-coros',
    priority: 1,
  },
] as const satisfies readonly TipDefinition[];
