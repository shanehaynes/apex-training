import type { Page } from '@playwright/test';

// The shared intercept stubs exercise_definitions empty (offline mode), which
// leaves the picker and the Library with nothing to search. A spec that needs
// a library brings this one, so it runs in CI's mock job rather than joining
// the expected skips.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

export const LIBRARY = [
  ['pancake-fold', 'Pancake Fold', 'stretch'],
  ['pancake-hold', 'Pancake Hold', 'stretch'],
  ['bench-press', 'Bench Press', 'strength'],
].map(([id, name, category]) => ({
  id, canonical_name: name, aliases: [], category, muscle_groups: [], equipment: [], is_unilateral: false,
  image_url: null, technique_notes: null, default_sets: null, default_reps: null, default_duration: null,
  default_weight: null, default_rest: null, archived_at: null,
}));

export async function stubLibrary(page: Page, rows = LIBRARY) {
  await page.route('**/rest/v1/exercise_definitions**', route =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(rows) }));
}
