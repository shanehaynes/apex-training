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
if (!['smoke', 'tracker', 'today', 'reschedule', 'library', 'edit-exercises'].includes(mode)) {
  console.error('usage: driver.mjs <smoke|tracker|today|reschedule|library|edit-exercises>');
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
    // Library detail history: exercise_name filter without the tracker's
    // event_date=lt. bound. Fabricate three sessions of growing holds so the
    // PR card, trend chart, and session list all render.
    if (decoded.includes('exercise_name=in.') && !decoded.includes('event_date=lt.')) {
      const m = decoded.match(/exercise_name=in\.\(([^)]*)\)/);
      const name = m ? m[1].split(',')[0].replace(/^"|"$/g, '').trim() : 'Exercise';
      return json(req, ['2000-01-01', '2000-01-08', '2000-01-15'].map((event_date, i) => ({
        event_id: `driver-hist-${i}`, event_date, section: 'exercise',
        exercise_id: 'hist', exercise_name: name, set_number: 1,
        planned_weight: null, planned_reps: null, planned_duration: null,
        actual_weight: null, actual_reps: null, actual_duration: `${45 + i * 15}s`,
        is_autofilled: false,
      })));
    }
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

  if (mode === 'today') {
    const todayState = () => page.$eval('.btn-today', el => el.disabled);
    const period = () => page.$eval('.nav-period', el => el.textContent);

    if (!await todayState()) errors.push('assert: Today should be disabled on the current period');
    await shot('today-disabled');

    await page.click('.nav-arrow[aria-label="Next"]');
    await settle(300);
    if (await todayState()) errors.push('assert: Today should be enabled after paging forward');
    await shot('today-enabled');

    const away = await period();
    await page.click('.btn-today');
    await settle(300);
    if (await period() === away) errors.push('assert: clicking Today should return to the current period');
    if (!await todayState()) errors.push('assert: Today should be disabled again after clicking it');
    await shot('today-after-click');

    console.log('console/assert errors:', errors.length ? errors : 'none');
    process.exitCode = errors.length ? 1 : 0;
    await browser.close();
    process.exit();
  }

  if (mode === 'library') {
    await page.click('.btn-library');
    await page.waitForSelector('.library-row', { timeout: 10000 });
    await settle(300);
    await shot('library-list');

    await page.click('.library-row');
    await page.waitForSelector('.library-detail', { timeout: 10000 });
    await settle(500);
    await shot('library-detail');

    await page.click('.library-edit-btn');
    await page.waitForSelector('.library-editor', { timeout: 5000 });
    await settle(300);
    await shot('library-editor');
    await page.click('.library-editor__cancel');
    await settle(200);

    // Deep link: an exercise name in the workout modal opens its detail page.
    await page.click('.library-close');
    await settle(300);
    await page.click('.event-chip__main');
    await page.waitForSelector('.exercise-card__name--link', { timeout: 10000 });
    await page.click('.exercise-card__name--link');
    await page.waitForSelector('.library-detail', { timeout: 10000 });
    await settle(500);
    await shot('library-deeplink');

    console.log('console errors:', errors.length ? errors : 'none');
    process.exitCode = errors.length ? 1 : 0;
    await browser.close();
    process.exit();
  }

  await page.click('.event-chip__main');
  await page.waitForSelector('.modal-completion__btn--start', { timeout: 10000 });
  await settle(300);
  await shot('event-modal');

  if (mode === 'reschedule') {
    // The date chip swaps to a native date input on click.
    const chips = await page.$$('.modal-meta-item--edit');
    if (chips.length < 2) errors.push(`assert: expected date + time edit chips, found ${chips.length}`);

    await chips[0].click();
    const dateInput = await page.waitForSelector('.modal-meta-input[type="date"]', { timeout: 5000 });
    await shot('reschedule-date-editing');
    // Escape cancels without committing and restores the text display.
    await dateInput.press('Escape');
    await settle(200);
    if (!(await page.$('.modal-meta-item--edit'))) errors.push('assert: Escape should restore the date display');
    if (await page.$('.modal-backdrop') === null) errors.push('assert: Escape in the input must not close the modal');

    // The time chip swaps to start/end time inputs on click.
    await (await page.$$('.modal-meta-item--edit'))[1].click();
    await page.waitForSelector('.modal-meta-input[type="time"]', { timeout: 5000 });
    const timeInputs = await page.$$('.modal-meta-input[type="time"]');
    if (timeInputs.length !== 2) errors.push(`assert: expected 2 time inputs, found ${timeInputs.length}`);
    await shot('reschedule-time-editing');

    console.log('console/assert errors:', errors.length ? errors : 'none');
    process.exitCode = errors.length ? 1 : 0;
    await browser.close();
    process.exit();
  }

  if (mode === 'edit-exercises') {
    await page.click('.modal-edit-exercises');
    await page.waitForSelector('.editor-card', { timeout: 10000 });
    await settle(300);
    const cardsBefore = (await page.$$('.editor-card')).length;
    await shot('edit-exercises-editor');

    // Add via the picker into the first (Warm-Up) section.
    await page.click('.exercise-editor__add');
    await page.waitForSelector('.exercise-picker__row', { timeout: 10000 });
    await page.type('.exercise-picker__input', 'plank');
    await settle(300);
    await shot('edit-exercises-picker');
    const addedName = await page.$eval('.exercise-picker__row-name', el => el.textContent);
    await page.click('.exercise-picker__row');
    await settle(300);

    const cardsAfter = (await page.$$('.editor-card')).length;
    if (cardsAfter !== cardsBefore + 1) {
      errors.push(`assert: expected ${cardsBefore + 1} editor cards after add, found ${cardsAfter}`);
    }

    // Edit a prescription field on the new card, then save (PATCH is stubbed;
    // the optimistic update must surface the change in the read view).
    const inputs = await page.$$('.editor-card:last-of-type .editor-field input');
    if (inputs.length) { await inputs[0].click({ clickCount: 3 }); await inputs[0].type('4'); }
    await shot('edit-exercises-added');

    await page.click('.exercise-editor__save');
    await page.waitForSelector('.exercise-card', { timeout: 10000 });
    await settle(400);
    const bodyText = await page.$eval('.modal-body', el => el.textContent);
    if (addedName && !bodyText.includes(addedName)) {
      errors.push(`assert: "${addedName}" should appear in the modal after save`);
    }
    await shot('edit-exercises-saved');

    console.log('console/assert errors:', errors.length ? errors : 'none');
    process.exitCode = errors.length ? 1 : 0;
    await browser.close();
    process.exit();
  }

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
