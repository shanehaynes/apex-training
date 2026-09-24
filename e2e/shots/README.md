# Help-page screenshot generators

Each `<slug>.shots.ts` here drives the mock app and writes the screenshots
`help/<slug>.md` shows. They are generators, not tests: `npm run e2e`, `agent:check`
and CI all run `--project=mock` only, so nothing here runs unless named.

## Run

```bash
APEX_PORT=<your port> npx playwright test --project=shots-phone --project=shots-desktop e2e/shots/<slug>.shots.ts
```

Writes `public/help/<slug>/<nn>-<name>.phone.png` (375×812) and
`public/help/<slug>/<nn>-<name>.desktop.png` (1280×950), both at 2x. Pass one
project to write one variant. Review the PNGs, commit them with the page, and run
`npx vitest run src/lib/help` — it fails on a referenced PNG that is missing and on a
PNG that nothing references. Do not run `npx playwright test` without `--project`:
that runs every project, generators included, and rewrites every committed image.

## Writing one

```ts
import { test, expect, gotoCalendar } from '../lib/fixtures';
import { helpShot } from '../lib/helpShots';

// Illustrative — the selectors are whatever the screen needs.
test('logging a workout', async ({ page }, testInfo) => {
  // gotoCalendar waits for a month-grid chip, which only a desktop shows; a
  // phone opens on the day view — wait for `.day-view` there instead.
  test.skip(testInfo.project.name !== 'shots-desktop', 'desktop-only shot');
  await gotoCalendar(page);
  await page.locator('.event-chip__main').first().click();
  const start = page.getByRole('button', { name: 'Start Workout' });
  await expect(start).toBeVisible();
  await helpShot(page, { slug: 'logging-a-workout', n: 1, name: 'start-workout', highlight: start });
});
```

- `test` comes from `../lib/fixtures`: the same intercepts, signed-in session, pinned
  clock and no-console-errors check as the mock specs. Signed-out:
  `test.use({ sessionSeed: false })`.
- Extra data a shot needs (a PR, a connected COROS account) goes through `page.route`
  inside the spec — never edit the shared intercepts for a picture.
- `helpShot` waits 400 ms for framer-motion entrances (`animations: 'disabled'` does not
  stop them), rings `highlight` in `--positive` for the shot only, and returns the `src`
  to paste into the markdown.
- `n` orders the steps (`01-`, `02-` …); `name` is lowercase-dashed. Phone vs desktop
  comes from the viewport, so a spec that must only produce one variant skips the other
  project, as above.
- Fonts: Inter and JetBrains Mono are not installed on the Linux box, so shots taken
  there use fallback fonts until they are (docs/onboarding/MASTER.md, "Screenshot
  pipeline").

`_proof.shots.ts` exercises the pipeline without touching `public/`; it writes to
`APEX_SHOTS_OUT` (or its `test-results/` directory).
