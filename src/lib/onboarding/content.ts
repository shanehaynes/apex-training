// Every word a new user reads during setup lives here, so the welcome flow
// and the getting-started checklist can't drift apart — which is exactly what
// happened to the starter-plan offer this replaces: two copies of one message,
// in a banner and in ProfileView, worded differently.
//
// Keep bodies at 35 words or fewer (content.test.ts counts them). The brief is
// "many features, few words", and a card nobody finishes teaches nothing.
//
// No runtime imports, ever: ios/scripts/gen-onboarding-catalog.mjs loads this
// file under Node's type stripping and compiles it into the Swift catalog.

/** What a step or checklist row's button does. Handlers live in useOnboardingActions. */
export type ActionKind = 'copy-template' | 'open-profile' | 'connect-coros';

export interface StepAction {
  label: string;
  kind: ActionKind;
}

export interface WelcomeStep {
  id: string;
  title: string;
  body: string;
  /**
   * The same step, worded for the iOS app, where that app is a different
   * thing — it has no week view (D-009) and "on a phone" is where the reader
   * already is. The web always renders `body`; `gen-onboarding-catalog.mjs`
   * emits this into the Swift catalog and falls back to `body`.
   */
  iosBody?: string;
  action?: StepAction;
  /** Opens in a new tab — the flow is one-shot, don't navigate out of it. */
  link?: { label: string; href: string };
  /** Dropped entirely when no watch provider is configured for the deployment. */
  requiresCoros?: boolean;
}

/**
 * The help index. Relative on purpose: every link in the intro is Apex-hosted.
 * vercel.json's SPA rewrite serves index.html for /help, and App.tsx matches
 * /help and /help/<slug> before AuthProvider (lane O04), so it resolves
 * signed in or out. The iOS app has to resolve these against the web origin
 * (its WelcomeFlowView, the later parity session).
 */
export const GUIDE_URL = '/help';

// Four cards, then silence (docs/onboarding/MASTER.md, "Intro"; D-O05). Every
// other feature is taught by a tip the first time the user reaches it, so a
// fifth card here is a regression, not an addition. **Bold** names a button by
// its on-screen label; WelcomeFlow renders it.
export const WELCOME_STEPS: WelcomeStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Apex',
    body: 'Your calendar is home. Every workout sits on a day. Tap a day to see what is planned, and tap a workout to open it.',
  },
  {
    id: 'plan',
    title: 'Put something on it',
    body: 'Start fast with Shane’s ready-made weekly plan. Change or delete any of it later. Or add your own workout with the **+** button at the bottom.',
    iosBody: 'Start fast with Shane’s ready-made weekly plan. Change or delete any of it later. Or add your own workout with the **+** at the top.',
    action: { label: 'Copy the starter plan', kind: 'copy-template' },
  },
  {
    id: 'log',
    title: 'Log a workout',
    // No iosBody: the phone's button reads "Mark as Complete" too (EventSheet.swift).
    body: 'Open a workout and press **Start Workout** to log each set as you go. In a hurry? **Mark as Complete** records it in one tap.',
  },
  {
    id: 'coach',
    title: 'Meet your coach',
    body: 'The **Coach** tab answers questions about your training and can plan workouts for you. It needs a key from Anthropic first — a few minutes, billed to you, not Apex.',
    action: { label: 'Add key', kind: 'open-profile' },
    link: { label: 'Get an API key', href: '/help/get-api-key' },
  },
];

/** Ids are the contract between the copy here and the signals in useOnboardingProgress. */
export type ChecklistId = 'template' | 'key' | 'goal' | 'coros' | 'connector';

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  hint: string;
  action: StepAction;
  requiresCoros?: boolean;
}

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  {
    id: 'template',
    label: 'Add a starter plan',
    hint: 'Copy Shane’s recurring workouts as a base — edit or delete anything afterwards.',
    action: { label: 'Copy', kind: 'copy-template' },
  },
  {
    id: 'key',
    label: 'Add your Anthropic API key',
    hint: 'The coach and post-workout summaries stay switched off until you do. See Get an API key under Help.',
    action: { label: 'Add key', kind: 'open-profile' },
  },
  {
    id: 'goal',
    label: 'Tell the coach your goal',
    hint: 'One line. It shapes every answer and every summary you get.',
    action: { label: 'Set goal', kind: 'open-profile' },
  },
  {
    id: 'coros',
    label: 'Connect your watch',
    hint: 'COROS activities sync in every night, with heart rate, elevation, and route.',
    action: { label: 'Connect', kind: 'connect-coros' },
    requiresCoros: true,
  },
  {
    id: 'connector',
    label: 'Connect Claude or ChatGPT',
    hint: 'Ask about your training from an assistant. Read-only — it can never change anything.',
    action: { label: 'Connect', kind: 'open-profile' },
  },
];

/** Shown under the checklist: real features, but nothing to tick off. */
export const EXTRA_NOTES: string[] = [
  'Subscribe to your schedule from Apple or Google Calendar — Profile → Calendar feed.',
  'When a training month closes, a review of it lands in your inbox.',
];
