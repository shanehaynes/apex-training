// Every word a new user reads during setup lives here, so the welcome flow
// and the getting-started checklist can't drift apart — which is exactly what
// happened to the starter-plan offer this replaces: two copies of one message,
// in a banner and in ProfileView, worded differently.
//
// Keep bodies under ~35 words. The brief is "many features, few words", and a
// card nobody finishes teaches nothing.

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
  action?: StepAction;
  /** Opens in a new tab — the flow is one-shot, don't navigate out of it. */
  link?: { label: string; href: string };
  /** Dropped entirely when no watch provider is configured for the deployment. */
  requiresCoros?: boolean;
}

/** The user guide. Absolute because the app is a SPA — a relative path 404s. */
export const GUIDE_URL = 'https://github.com/shanehaynes/apex-training/blob/main/WELCOME.md';

export const WELCOME_STEPS: WelcomeStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Apex',
    body: 'Plan your training on a calendar, log it as you go, and let a coach that reads your actual numbers help you steer. Here is the whole app in about a minute.',
  },
  {
    id: 'calendar',
    title: 'Your calendar',
    body: 'Month, week, or day. Tap any day to add a workout or a meal, and workouts can repeat on a rule. Want a head start? Copy Shane’s recurring plan.',
    action: { label: 'Copy the starter plan', kind: 'copy-template' },
  },
  {
    id: 'tracker',
    title: 'Log as you lift',
    body: 'Open a workout and press Start. Log sets against the plan, tap to reuse last session’s numbers, and finish to see any records — estimated 1RM included. Or just mark it complete.',
  },
  {
    id: 'coach',
    title: 'Meet your coach',
    body: 'Ask the chat rail anything about your training, or tap Coach’s Notes for a daily briefing. It can add and edit workouts and meals too, always behind a confirm.',
    action: { label: 'Add your Anthropic key', kind: 'open-profile' },
  },
  {
    id: 'structure',
    title: 'Blocks, library, meals',
    body: 'Training blocks give a stretch of weeks real weekly targets, and show what you actually hit. The exercise library keeps history per movement. Logged meals feed the coach as well.',
  },
  {
    id: 'coros',
    title: 'Your watch, automatically',
    body: 'Connect COROS once and it syncs itself every night — heart rate, elevation, route. An activity that matches a planned workout waits for your yes before filling it in.',
    action: { label: 'Connect COROS', kind: 'connect-coros' },
    requiresCoros: true,
  },
  {
    id: 'connectors',
    title: 'Claude and ChatGPT',
    body: 'Connect Apex as a tool and ask about your training from Claude or ChatGPT. Strictly read-only — an assistant can look at everything and change nothing.',
    action: { label: 'Set up a connector', kind: 'open-profile' },
  },
  {
    id: 'more',
    title: 'A few last things',
    body: 'Subscribe to your schedule from Apple or Google Calendar, and expect a review email when a training month closes. On a phone, Apex shows one day at a time.',
    link: { label: 'Read the full guide', href: GUIDE_URL },
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
    hint: 'The coach and post-workout summaries stay switched off until you do.',
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
