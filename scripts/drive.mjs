#!/usr/bin/env node
// Interactive driving CLI for agents — one browser session per invocation,
// commands executed left to right against this checkout's dev server
// (dev/port.mjs — `npm run -s port`; APP_URL overrides).
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

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// WHY THE RE-EXEC: this file's import graph reaches TypeScript
// (e2e/lib/intercept.mjs → src/lib/tracking/plan.ts), and those modules import
// their siblings by `.js` specifier. Node's type stripping runs a `.ts` file but
// does not remap `.js` → `.ts`, so plain `node` died on `../climbing.js` before a
// line of this script ran. Playwright's loader does remap them, which is why the
// specs passed while this CLI did not. So re-exec once through the tsx
// devDependency and keep `node scripts/drive.mjs …` — the invocation
// .claude/agents/app-verifier.md and the run-apex-training skill both prescribe —
// working as documented.
//
// The four imports below are dynamic on purpose: static imports are linked
// before any statement executes, so a static import of intercept.mjs would crash
// before this guard could run. Everything above it is a node: builtin, so the
// re-exec survives the very failure it exists to prevent.
if (process.env.APEX_DRIVE_TSX !== '1' && !process.execArgv.some(arg => arg.includes('tsx'))) {
  let tsx;
  try {
    tsx = import.meta.resolve('tsx');
  } catch {
    console.error('drive.mjs needs the tsx devDependency — install this checkout first: npm ci');
    process.exit(1);
  }
  const child = spawnSync(
    process.execPath,
    ['--import', tsx, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, APEX_DRIVE_TSX: '1' } },
  );
  if (child.error) {
    console.error(`drive.mjs could not start tsx: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

const { chromium } = await import('@playwright/test');
const { installIntercept, isExpectedConsoleError } = await import('../e2e/lib/intercept.mjs');
const { readSupabaseEnv, seedFabricatedSession, driverProfile } = await import('../e2e/lib/session.mjs');
const { devPort } = await import('../dev/port.mjs');

const APP_URL = process.env.APP_URL ?? `http://localhost:${devPort()}/`;
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
// Agent-driven screenshots must never carry a tip card (feature lanes call
// useTip); APEX_DRIVE_TIPS=on leaves tips on, to look at one deliberately.
if (process.env.APEX_DRIVE_TIPS !== 'on') {
  await context.addInitScript(() => { window.__APEX_TIPS_OFF__ = true; });
}

// APEX_FAKE_NOW=2026-03-02T08:00:00 freezes the app's date-semantic clock
// (see src/lib/clock.ts) so calendar output is reproducible.
if (process.env.APEX_FAKE_NOW) {
  await context.addInitScript(v => { window.__APEX_FAKE_NOW__ = v; }, process.env.APEX_FAKE_NOW);
}

const page = await context.newPage();
const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error' && !isExpectedConsoleError(msg)) errors.push(msg.text());
});

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
