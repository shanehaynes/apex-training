// The help-page screenshot writer. A generator spec (e2e/shots/<slug>.shots.ts)
// drives the mock app to a state and calls helpShot(); the PNG lands where
// help/<slug>.md references it, named so helpMarkdownViolations() accepts it:
//
//   public/help/<slug>/<nn>-<name>.<phone|desktop>.png
//
// phone/desktop follows the viewport, so one spec run under both projects
// (shots-phone, shots-desktop — playwright.config.ts) writes both variants.
// Run command and conventions: e2e/shots/README.md.

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { HelpSlug } from '../../src/lib/help/pages';

/** The repo's public/ — resolved from this file, not the cwd. */
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

/** Same breakpoint the app's phone layout uses. */
const PHONE_MAX_WIDTH = 600;

export interface HelpShotOptions {
  slug: HelpSlug;
  /** Step number, 1–99; becomes the two-digit prefix that orders the files. */
  n: number;
  /** Lowercase words joined by dashes, e.g. 'start-workout'. */
  name: string;
  /** Ring this element for the shot — "tap here". Removed afterwards. */
  highlight?: Locator;
  /**
   * Write under this directory instead of public/ (the file still goes to
   * <outDir>/help/<slug>/…). For proofs and experiments that must not touch
   * the committed images.
   */
  outDir?: string;
}

/**
 * Screenshot the viewport into the page's image directory. Returns the `src`
 * to paste into help/<slug>.md, e.g. `/help/get-api-key/02-key-saved.phone.png`.
 */
export async function helpShot(page: Page, { slug, n, name, highlight, outDir }: HelpShotOptions): Promise<string> {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`helpShot: n must be 1–99, got ${n}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`helpShot: name must be lowercase-dashed, got '${name}'`);

  const width = page.viewportSize()?.width ?? 1280;
  const device = width < PHONE_MAX_WIDTH ? 'phone' : 'desktop';
  const file = `${String(n).padStart(2, '0')}-${name}.${device}.png`;

  // framer-motion drives its entrances from JS, which `animations: 'disabled'`
  // does not reach — give them time to land. Fonts too, or the first shot of
  // a run can catch the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // The ring is a fixed-position overlay drawn over the element's box, not an
  // outline on the element itself: cards clip their children (overflow:
  // hidden), which would cut an outline down to a stray bar or two.
  if (highlight) {
    const box = await highlight.boundingBox();
    if (!box) throw new Error('helpShot: highlight is not visible');
    await page.evaluate(({ x, y, width, height }) => {
      const ring = document.createElement('div');
      ring.dataset.helpShotRing = '';
      Object.assign(ring.style, {
        position: 'fixed',
        left: `${x - 4}px`,
        top: `${y - 4}px`,
        width: `${width + 8}px`,
        height: `${height + 8}px`,
        border: '3px solid var(--positive)',
        borderRadius: '10px',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });
      document.body.append(ring);
    }, box);
  }

  try {
    await page.screenshot({
      path: join(outDir ?? PUBLIC_DIR, 'help', slug, file),
      animations: 'disabled',
      caret: 'hide',
    });
  } finally {
    if (highlight) await page.evaluate(() => document.querySelectorAll('[data-help-shot-ring]').forEach(el => el.remove()));
  }

  return `/help/${slug}/${file}`;
}
