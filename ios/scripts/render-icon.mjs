#!/usr/bin/env node
// Renders ios/Design/app-icon*.svg into the app's asset catalog.
//
// Chromium (already in the repo's Playwright cache) is the only SVG rasteriser
// on a stock Mac + this repo that hits an exact pixel size with a controllable
// alpha channel — rsvg-convert, inkscape and ImageMagick are not installed, and
// none is worth a brew dependency for a file regenerated a few times a year.
//
//   node ios/scripts/render-icon.mjs
//
// Fallback with no node_modules (verify the size afterwards — qlmanage letterboxes):
//   qlmanage -t -s 1024 -o /tmp ios/Design/app-icon.svg
//   sips -g pixelWidth -g pixelHeight /tmp/app-icon.svg.png
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IOS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(IOS, 'Apex/Assets.xcassets/AppIcon.appiconset');

const { chromium } = await import('playwright').catch(() => {
  console.error('::error::playwright is not installed. Run `npm ci` in this worktree first.');
  process.exit(1);
});

const variants = [
  { svg: 'app-icon.svg', png: 'AppIcon-1024.png' },
  // The app is dark-only, so the dark appearance is the same art. It is present
  // so iOS 18+ uses it rather than synthesising a dark version of its own.
  { svg: 'app-icon.svg', png: 'AppIcon-1024-dark.png' },
  { svg: 'app-icon-mono.svg', png: 'AppIcon-1024-tinted.png' },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });

for (const { svg, png } of variants) {
  const source = readFileSync(join(IOS, 'Design', svg), 'utf8');
  await page.setContent(`<body style="margin:0;padding:0">${source}</body>`);
  await page.screenshot({ path: join(OUT, png) });
  console.log(`wrote ${png}`);
}
await browser.close();

writeFileSync(
  join(OUT, 'Contents.json'),
  `${JSON.stringify(
    {
      images: [
        { filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
        {
          appearances: [{ appearance: 'luminosity', value: 'dark' }],
          filename: 'AppIcon-1024-dark.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
        {
          appearances: [{ appearance: 'luminosity', value: 'tinted' }],
          filename: 'AppIcon-1024-tinted.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
      ],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2,
  )}\n`,
);
console.log('wrote Contents.json');
