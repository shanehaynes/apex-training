#!/usr/bin/env node
// Interactive driving CLI for agents — one browser session per invocation,
// commands executed left to right against the dev server on :5173.
//
//   node scripts/drive.mjs <command> [args] [<command> [args] ...]
//
// Commands:
//   goto <path>             navigate (relative to APP_URL)
//   wait <selector>         wait for the first match to be visible
//   click <selector>        click the first match
//   fill <selector> <text>  fill the first matching input
//   press <key>             keyboard key (e.g. Escape, Enter)
//   state <key|all>         print a dev-bridge snapshot as JSON (window.__apex)
//   eval <js>               evaluate an expression in the page, print JSON
//   shot <name>             screenshot to e2e/screenshots/<name>.png
//   pause <ms>              settle delay
//
// Example:
//   node scripts/drive.mjs state schedule
//   node scripts/drive.mjs click .btn-library shot library state calendar
//
// SAFETY: runs with the same interception layer as the Playwright mock
// project — /api/* and all non-GET supabase requests are stubbed, so nothing
// driven here can mutate real data.

import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { installIntercept } from '../e2e/lib/intercept.mjs';
import { readSupabaseEnv, seedFabricatedSession, driverProfile } from '../e2e/lib/session.mjs';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/';
const SHOTS = 'e2e/screenshots';

const ARG_COUNT = { goto: 1, wait: 1, click: 1, fill: 2, press: 1, state: 1, eval: 1, shot: 1, pause: 1 };

// Parse the whole command stream up front so a typo fails before launch.
const ops = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; ) {
  const cmd = argv[i++];
  const n = ARG_COUNT[cmd];
  if (n === undefined) {
    console.error(`unknown command: ${cmd}\nusage: drive.mjs <goto|wait|click|fill|press|state|eval|shot|pause> ...`);
    process.exit(2);
  }
  const args = argv.slice(i, i + n);
  if (args.length < n) {
    console.error(`${cmd} needs ${n} argument(s)`);
    process.exit(2);
  }
  i += n;
  ops.push({ cmd, args });
}
if (!ops.length) {
  console.error('usage: drive.mjs <goto|wait|click|fill|press|state|eval|shot|pause> [args] ...');
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });

const { ref, anonKey } = readSupabaseEnv();
await installIntercept(context, { anonKey, profile: driverProfile() });
if (ref) await seedFabricatedSession(context, ref);

// APEX_FAKE_NOW=2026-03-02T08:00:00 freezes the app's date-semantic clock
// (see src/lib/clock.ts) so calendar output is reproducible.
if (process.env.APEX_FAKE_NOW) {
  await context.addInitScript(v => { window.__APEX_FAKE_NOW__ = v; }, process.env.APEX_FAKE_NOW);
}

const page = await context.newPage();
const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

  for (const { cmd, args } of ops) {
    switch (cmd) {
      case 'goto':
        await page.goto(new URL(args[0], APP_URL).href, { waitUntil: 'networkidle', timeout: 30000 });
        break;
      case 'wait':
        await page.locator(args[0]).first().waitFor({ state: 'visible', timeout: 20000 });
        break;
      case 'click':
        await page.locator(args[0]).first().click();
        break;
      case 'fill':
        await page.locator(args[0]).first().fill(args[1]);
        break;
      case 'press':
        await page.keyboard.press(args[0]);
        break;
      case 'state': {
        const key = args[0] === 'all' ? undefined : args[0];
        const value = await page.evaluate(k => window.__apex?.state(k), key);
        console.log(JSON.stringify(value ?? null, null, 2));
        break;
      }
      case 'eval': {
        const value = await page.evaluate(args[0]);
        console.log(JSON.stringify(value ?? null, null, 2));
        break;
      }
      case 'shot': {
        const path = `${SHOTS}/${args[0]}.png`;
        await page.screenshot({ path });
        console.error(`screenshot: ${path}`);
        break;
      }
      case 'pause':
        await page.waitForTimeout(Number(args[0]));
        break;
    }
  }

  if (errors.length) {
    console.error('console errors:', errors);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`drive failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
