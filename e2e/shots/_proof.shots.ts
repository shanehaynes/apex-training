// Proves the screenshot pipeline end to end — both projects, the fixtures,
// helpShot's naming and the highlight ring — without committing an image: the
// PNG goes to APEX_SHOTS_OUT when set, otherwise this test's own directory
// under test-results/ (gitignored). Never public/.
//
//   APEX_SHOTS_OUT=/some/scratch npx playwright test \
//     --project=shots-phone --project=shots-desktop e2e/shots/_proof.shots.ts

import { test, expect, gotoCalendar } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';

test('the pipeline writes a calendar shot for this viewport', async ({ page }, testInfo) => {
  const phone = testInfo.project.name === 'shots-phone';
  // gotoCalendar waits for a month-grid chip, which a phone never shows — it
  // opens on the day view.
  if (phone) {
    await page.goto('/');
    await page.locator('.day-view').waitFor({ state: 'visible', timeout: 20000 });
  } else {
    await gotoCalendar(page);
  }

  const chip = phone
    ? page.locator('.day-view').getByRole('button', { name: /^Open / }).first()
    : page.locator('.event-chip__main').first();
  const outDir = process.env.APEX_SHOTS_OUT ?? testInfo.outputPath();
  const src = await helpShot(page, { slug: 'logging-a-workout', n: 1, name: 'proof-calendar', highlight: chip, outDir });

  const device = phone ? 'phone' : 'desktop';
  expect(src).toBe(`/help/logging-a-workout/01-proof-calendar.${device}.png`);
  // The ring is for the picture only; the page is left as it was.
  await expect(page.locator('[data-help-shot-ring]')).toHaveCount(0);

  console.log(`proof shot: ${outDir}${src}`);
});
