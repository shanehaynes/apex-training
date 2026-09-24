// The help pages Apex hosts at /help/<slug>. Data only — the renderer (I3,
// src/components/help/) imports the markdown; tips (src/lib/onboarding/tips/)
// and the intro (content.ts) reference a page by slug, so a typo is a type
// error rather than a 404 a new user meets.
//
// `.js` specifiers because api/_lib/handlers/profile.ts imports the tip
// catalog, which imports this (api/__tests__/esm-imports.test.ts).

export const HELP_PAGES = [
  {
    slug: 'get-api-key',
    title: 'Get an API key',
    summary: 'The coach runs on a key from Anthropic. How to get one, what it costs, and what to do if you already pay for Claude.',
  },
  {
    slug: 'connect-coros',
    title: 'Connect your COROS watch',
    summary: 'Link your watch once and your runs, rides and hikes come in on their own.',
  },
  {
    slug: 'calendar-feed',
    title: 'See your workouts in your phone’s calendar',
    summary: 'Subscribe from Apple or Google Calendar so your plan shows up next to everything else.',
  },
  {
    slug: 'logging-a-workout',
    title: 'Logging a workout',
    summary: 'Start Workout or Mark as Complete, the grey numbers, blank sets, and the trophies at the end.',
  },
  {
    slug: 'repeating-workouts',
    title: 'Workouts that repeat',
    summary: 'Weekly workouts, and which changes reach one day or every week.',
  },
] as const;

export type HelpSlug = (typeof HELP_PAGES)[number]['slug'];

export const HELP_SLUGS: readonly HelpSlug[] = HELP_PAGES.map(p => p.slug);

export function helpPath(slug: HelpSlug): string {
  return `/help/${slug}`;
}
