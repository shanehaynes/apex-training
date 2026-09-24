import type { HelpSlug } from './pages';
import getApiKey from '../../../help/get-api-key.md?raw';
import connectCoros from '../../../help/connect-coros.md?raw';
import calendarFeed from '../../../help/calendar-feed.md?raw';
import loggingAWorkout from '../../../help/logging-a-workout.md?raw';
import repeatingWorkouts from '../../../help/repeating-workouts.md?raw';

// The markdown behind each help page, bundled at build time (?raw) so a page
// always matches the deployed UI it describes. Kept out of pages.ts on
// purpose: that file is imported by the tip catalog, which the API handler
// imports too, and a `?raw` specifier means nothing outside Vite.
//
// Record<HelpSlug, …> makes a slug added to HELP_PAGES without a source here
// a type error; src/lib/help/__tests__/documents.test.ts checks the files.

export const HELP_SOURCES: Record<HelpSlug, string> = {
  'get-api-key': getApiKey,
  'connect-coros': connectCoros,
  'calendar-feed': calendarFeed,
  'logging-a-workout': loggingAWorkout,
  'repeating-workouts': repeatingWorkouts,
};
