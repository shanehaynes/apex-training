#!/usr/bin/env node
// Headless driver for the Apex Training web app.
//
// Usage:  node .claude/skills/run-apex-training/driver.mjs <smoke|tracker>
//
// Requires: the Vite dev server on http://localhost:5173 (npm run dev),
// /usr/bin/google-chrome, and puppeteer-core (npm i --no-save puppeteer-core).
//
// SAFETY: .env.local points the app at the real Supabase project. This
// driver intercepts every request that could write — /api/* and all
// non-GET supabase calls — and answers them with stubs, so nothing you
// click here ever mutates real workout data. Tracker log reads are also
// stubbed with fabricated history so the "prev" column renders
// deterministically. Calendar event reads pass through untouched.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const mode = process.argv[2];
if (!['smoke', 'tracker'].includes(mode)) {
  console.error('usage: driver.mjs <smoke|tracker>');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 950 });

const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

// puppeteer's req.respond bypasses the server, so the browser enforces CORS
// against the stub itself — every stub needs these headers, and OPTIONS
// preflights need an explicit 204.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};
const json = (req, body) =>
  req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

await page.setRequestInterception(true);
page.on('request', req => {
  const url = req.url();
  const isSupabase = url.includes('supabase.co');

  if (req.method() === 'OPTIONS' && (isSupabase || url.includes('/api/'))) {
    return req.respond({ status: 204, headers: CORS, body: '' });
  }

  // Vercel functions don't run under `vite dev` (they'd 404 anyway) and the
  // real ones write to Supabase — stub the whole surface.
  if (url.includes('/api/workout-sessions')) {
    return json(req, {
      session: {
        id: 'driver-session', event_id: 'x', event_date: '2000-01-01',
        started_at: new Date().toISOString(), finished_at: null,
        total_duration_seconds: null, updated_at: '',
      },
    });
  }
  if (url.includes('/api/')) return json(req, { ok: true });

  // Tracker log reads: fabricate one prior session per requested exercise so
  // the prev column has data. NOTE: query strings encode spaces as '+',
  // which decodeURIComponent does NOT translate — swap them first.
  if (url.includes('workout_set_logs')) {
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    if (decoded.includes('event_date=lt.')) {
      const m = decoded.match(/exercise_name=in\.\(([^)]*)\)/);
      const names = m ? m[1].split(',').map(s => s.replace(/^"|"$/g, '').trim()) : [];
      return json(req, names.flatMap((name, i) => [1, 2].map(setNumber => ({
        event_id: 'driver-prev', event_date: '2000-01-01', section: 'exercise',
        exercise_id: `prev-${i}`, exercise_name: name, set_number: setNumber,
        planned_weight: null, planned_reps: null, planned_duration: null,
        actual_weight: null, actual_reps: null, actual_duration: setNumber === 1 ? '0:45' : '1:00',
        is_autofilled: false,
      }))));
    }
    return json(req, []);
  }
  if (url.includes('workout_cardio_logs')) return json(req, []);

  // Catch-all: no other write escapes to the real project.
  if (isSupabase && req.method() !== 'GET') return json(req, []);

  req.continue();
});

const shot = async name => {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  console.log(`screenshot: ${path}`);
};
const settle = ms => new Promise(r => setTimeout(r, ms));

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.event-chip__main', { timeout: 20000 });
  await shot('calendar');

  await page.click('.event-chip__main');
  await page.waitForSelector('.modal-completion__btn--start', { timeout: 10000 });
  await settle(300);
  await shot('event-modal');

  if (mode === 'tracker') {
    await page.click('.modal-completion__btn--start');
    await page.waitForSelector('.tracker-set', { timeout: 15000 });
    await settle(500);
    await shot('tracker-desktop');

    const prevBtn = await page.$('button.tracker-set__last');
    if (prevBtn) {
      await prevBtn.click();
      await settle(300);
      await shot('tracker-prev-filled');
    } else {
      console.log('warn: no prev button found (no set-tracked exercises in first event?)');
    }

    await page.setViewport({ width: 390, height: 844 });
    await settle(400);
    await shot('tracker-mobile');
  }

  console.log('console errors:', errors.length ? errors : 'none');
  process.exitCode = errors.length ? 1 : 0;
} finally {
  await browser.close();
}
