#!/usr/bin/env node
// Layer a full, believable training history onto the LOCAL agent@apex.local
// account so screenshots and screen recordings show a lived-in app. The
// persona is an alpinist: a Grand Teton trip already behind them, a winter
// ice objective and Denali's Cassin Ridge ahead, and the weeks between built
// the way mountain athletes actually train — max strength, then muscular
// endurance, zone 2 volume, long weighted-pack days, gym and crag climbing.
//
//   node scripts/seed-showcase.mjs            # (re)seed, dated around today
//   node scripts/seed-showcase.mjs --remove   # take it all back out
//
// Opt-in on purpose, never part of db:reset-local: the integration and live
// suites count agent@apex.local's rows, and this data moves with the clock.
// The weeks are laid out relative to today (16 back, 5 ahead), so a re-run
// first deletes every showcase row and then writes a fresh window. Every row
// it owns is findable — events and logs by the `showcase-` id prefix,
// definitions/objectives/blocks by the fixed ids below — so --remove leaves
// the base seed untouched. Variation comes from a fixed-seed PRNG.

import { readFileSync, readdirSync } from 'node:fs';
import { localSupabaseEnv } from './lib/localEnv.mjs';

const { url, serviceKey } = localSupabaseEnv();
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates',
};

async function rest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function insert(table, rows) {
  for (let i = 0; i < rows.length; i += 200) {
    await rest(`/rest/v1/${table}`, { method: 'POST', body: rows.slice(i, i + 200) });
  }
}

const { users } = await rest('/auth/v1/admin/users?per_page=100');
const agent = users.find(u => u.email === 'agent@apex.local');
if (!agent) {
  console.error('agent@apex.local does not exist — run scripts/create-local-users.mjs first');
  process.exit(1);
}
const uid = agent.id;

// ── Fixed identities ──────────────────────────────────────────────────────────

const OBJ = {
  teton:  '5ca1ab1e-0b1e-4c7e-8000-000000000001',
  pinnacle: '5ca1ab1e-0b1e-4c7e-8000-000000000002',
  denali: '5ca1ab1e-0b1e-4c7e-8000-000000000003',
};
const BLOCK = {
  base:   '5ca1ab1e-b10c-4c7e-8000-000000000001',
  me:     '5ca1ab1e-b10c-4c7e-8000-000000000002',
  winter: '5ca1ab1e-b10c-4c7e-8000-000000000003',
};

// Movements the base library lacks. Existing ids (back-squat, weighted-pull-ups,
// single-leg-rdl, …) are referenced as they are.
const DEFINITIONS = [
  def('weighted-box-step-up', 'Weighted Box Step-Up', 'strength', ['quads', 'glutes'], ['box', 'dumbbells'], true,
    'Full foot on a knee-height box. Drive through the heel, no push-off from the trailing leg. Control the descent — that eccentric is the descent off a peak.'),
  def('trap-bar-deadlift', 'Trap Bar Deadlift', 'strength', ['glutes', 'hamstrings', 'back'], ['trap bar'], false,
    'Hips and shoulders rise together. Brace before the pull, not during it.'),
  def('walking-lunge', 'Walking Lunge', 'strength', ['quads', 'glutes'], ['dumbbells'], true,
    'Long stride, back knee kisses the floor. Torso tall.'),
  def('split-squat-jump', 'Split Squat Jump', 'strength', ['quads', 'calves'], [], true,
    'Switch legs in the air, land soft. Stop the set when height drops.'),
  def('farmer-carry', 'Farmer Carry', 'strength', ['grip', 'traps', 'core'], ['kettlebells'], false,
    'Short quick steps, shoulders packed. Grip fails before posture does.'),
  def('overhead-press', 'Overhead Press', 'strength', ['shoulders', 'triceps'], ['barbell'], false,
    'Squeeze glutes, bar travels close to the face, finish with biceps by the ears.'),
  def('ice-tool-hang', 'Ice Tool Hang', 'skill', ['forearms', 'lats'], ['ice tools', 'pull-up bar'], false,
    'Hang from tools on a bar, slight bend in the elbows. Alternate offset lock-offs on later sets.'),
];

function def(id, name, category, muscleGroups, equipment, unilateral, notes) {
  return {
    id, canonical_name: name, aliases: [], category, muscle_groups: muscleGroups, equipment,
    image_url: null, technique_notes: notes, is_unilateral: unilateral,
    default_sets: null, default_reps: null, default_duration: null, default_weight: null, default_rest: null,
  };
}

// ── Remove ────────────────────────────────────────────────────────────────────

// What db:reset-local leaves on the profile — --remove puts these back.
const PROFILE_DEFAULTS = {
  display_name: 'agent', avatar_key: 'goat', coach_goal: '', coach_context: '',
  max_hr: null, threshold_hr: null, template_copied_at: null, tips_seen: {},
};

async function removeShowcase() {
  const own = `user_id=eq.${uid}`;
  await rest(`/rest/v1/profiles?id=eq.${uid}`, { method: 'PATCH', body: PROFILE_DEFAULTS });
  for (const table of ['workout_set_logs', 'workout_cardio_logs', 'workout_sessions', 'workout_completions']) {
    await rest(`/rest/v1/${table}?${own}&event_id=like.showcase-*`, { method: 'DELETE' });
  }
  await rest(`/rest/v1/workout_events?${own}&id=like.showcase-*`, { method: 'DELETE' });
  await rest(`/rest/v1/analytics_tiles?${own}&id=like.showcase-*`, { method: 'DELETE' });
  await rest(`/rest/v1/training_blocks?${own}&id=in.(${Object.values(BLOCK).join(',')})`, { method: 'DELETE' });
  await rest(`/rest/v1/objectives?${own}&id=in.(${Object.values(OBJ).join(',')})`, { method: 'DELETE' });
  await rest(`/rest/v1/exercise_definitions?${own}&id=in.(${DEFINITIONS.map(d => d.id).join(',')})`, { method: 'DELETE' });
}

await removeShowcase();
if (process.argv.includes('--remove')) {
  console.log('removed showcase data from agent@apex.local');
  process.exit(0);
}

// ── Calendar arithmetic (UTC dates, no DST surprises) ─────────────────────────

const DAY = 86_400_000;
const iso = d => d.toISOString().slice(0, 10);
const now = new Date();
const today = iso(now);
const todayUtc = new Date(`${today}T00:00:00Z`);
const thisMonday = new Date(todayUtc.getTime() - ((todayUtc.getUTCDay() + 6) % 7) * DAY);
const WEEKS_BACK = 16;
const WEEKS_AHEAD = 5;
const firstMonday = new Date(thisMonday.getTime() - WEEKS_BACK * 7 * DAY);
const mondayOf = w => new Date(firstMonday.getTime() + w * 7 * DAY);
const dayOf = (w, dow) => iso(new Date(mondayOf(w).getTime() + dow * DAY)); // dow 0 = Monday

// Blocks: base for the first 8 weeks, muscular endurance through week 18,
// then winter alpine prep running past the end of the planned window.
const W_ME = 8;
const W_WINTER = 18;
const TOTAL_WEEKS = WEEKS_BACK + WEEKS_AHEAD + 1;

// The Teton trip: approach Thursday, summit Friday of the second ME week.
const W_TETON = 9;

// mulberry32: same seed, same history.
let seed = 0x5ca1ab1e;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo, hi) => lo + rand() * (hi - lo);
const pick = xs => xs[Math.floor(rand() * xs.length)];
const round5 = n => Math.round(n / 5) * 5;

// ── Event builders ────────────────────────────────────────────────────────────

const events = [];

function event(w, dow, slot, fields) {
  const date = dayOf(w, dow);
  const e = {
    user_id: uid,
    id: `showcase-${date}-${slot}`,
    date,
    subtitle: null,
    start_time: null,
    end_time: null,
    description: '',
    warmup: [],
    exercises: [],
    cooldown: [],
    location: null,
    cover_image_url: null,
    tags: [],
    equipment: [],
    is_recurring: false,
    recurrence_rule: null,
    cardio_targets: null,
    climbing_targets: null,
    sport: null,
    ...fields,
  };
  e._week = w;
  events.push(e);
  return e;
}

let exSeq = 0;
const ex = (name, category, rx = {}) => ({ id: `sx-${++exSeq}`, name, category, ...rx });

function strengthDay(w) {
  const p = w / (W_ME - 1);
  const squat = round5(185 + 40 * p);
  const pull = round5(20 + 25 * p);
  const dead = round5(245 + 50 * p);
  return event(w, 1, 'strength', {
    type: 'weights',
    title: 'Max Strength',
    subtitle: 'Low reps, full rest — strength before endurance',
    start_time: '6:00 AM', end_time: '7:15 AM', estimated_duration: 75,
    difficulty: 4,
    description: 'Base-phase max strength. Heavy, few reps, 3 minutes between work sets. Stop every set with one rep in the tank — the point is recruitment, not fatigue.',
    location: 'Elm City Strength',
    tags: ['strength', 'base phase'],
    equipment: ['barbell', 'trap bar', 'pull-up bar'],
    warmup: [ex('Cat-Cow', 'mobility', { duration: '1 min', definitionId: 'cat-cow' }),
             ex('Banded Glute Bridges', 'mobility', { sets: 2, reps: '15', definitionId: 'banded-glute-bridges' })],
    exercises: [
      ex('Back Squat', 'strength', { sets: 4, reps: '5', weight: `${squat} lb`, restPeriod: '3 min', definitionId: 'back-squat' }),
      ex('Weighted Pull-Ups', 'strength', { sets: 4, reps: '5', weight: `${pull} lb`, restPeriod: '3 min', definitionId: 'weighted-pull-ups' }),
      ex('Trap Bar Deadlift', 'strength', { sets: 3, reps: '5', weight: `${dead} lb`, restPeriod: '3 min', definitionId: 'trap-bar-deadlift' }),
      ex('Single-Leg RDL', 'strength', { sets: 3, reps: '8', weight: `${round5(35 + 15 * p)} lb`, definitionId: 'single-leg-rdl' }),
      ex('Hanging Leg Raises', 'strength', { sets: 3, reps: '10', definitionId: 'hanging-leg-raises' }),
    ],
    cooldown: [ex('Pigeon Pose', 'stretch', { duration: '2 min', definitionId: 'pigeon-pose' })],
  });
}

function meDay(w) {
  const p = (w - W_ME) / (TOTAL_WEEKS - W_ME);
  const stepLoad = round5(30 + 25 * p);
  return event(w, 1, 'strength', {
    type: 'weights',
    title: 'Gym ME — Mountain Legs',
    subtitle: 'Muscular endurance circuit',
    start_time: '6:00 AM', end_time: '7:10 AM', estimated_duration: 70,
    difficulty: 4,
    description: 'Uphill Athlete-style muscular endurance. Move continuously through the circuit; the legs should burn by the third round and the heart rate stay below aerobic threshold.',
    location: 'Elm City Strength',
    tags: ['muscular endurance', 'legs', 'circuit'],
    equipment: ['box', 'dumbbells', 'kettlebells'],
    warmup: [ex('Deep Squat Hold', 'mobility', { duration: '2 min', definitionId: 'deep-squat-hold' })],
    exercises: [
      ex('Weighted Box Step-Up', 'strength', { sets: 4, reps: '20/leg', weight: `${stepLoad} lb`, superset: 'A', definitionId: 'weighted-box-step-up' }),
      ex('Walking Lunge', 'strength', { sets: 4, reps: '20', weight: `${round5(25 + 15 * p)} lb`, superset: 'A', definitionId: 'walking-lunge' }),
      ex('Split Squat Jump', 'strength', { sets: 4, reps: '20', superset: 'A', definitionId: 'split-squat-jump' }),
      ex('Farmer Carry', 'strength', { sets: 3, duration: '60s', weight: `${round5(53 + 17 * p)} lb`, definitionId: 'farmer-carry' }),
      ex('Weighted Pull-Ups', 'strength', { sets: 3, reps: '8', weight: `${round5(25 + 15 * p)} lb`, definitionId: 'weighted-pull-ups' }),
      ex('Copenhagen Plank', 'strength', { sets: 3, duration: '30s', definitionId: 'copenhagen-plank' }),
    ],
  });
}

function z2Run(w) {
  const build = w >= W_ME;
  const mins = Math.round(between(build ? 70 : 55, build ? 90 : 75) / 5) * 5;
  const miles = +(mins / between(9.4, 10.2)).toFixed(1);
  const vert = round5(between(450, build ? 1400 : 900));
  return event(w, 2, 'z2', {
    type: 'cardio', sport: 'running',
    title: build ? 'Zone 2 Trail Run' : 'Zone 2 Run',
    subtitle: 'Nasal breathing pace',
    start_time: '6:15 AM', end_time: null, estimated_duration: mins,
    difficulty: 2,
    description: 'Below aerobic threshold the whole way — if you cannot breathe through your nose, walk. This is the work that pays off on summit day.',
    location: build ? 'West Rock Ridge State Park' : 'Farmington Canal Trail',
    tags: ['zone 2', 'aerobic base'],
    cardio_targets: { distance: `${miles} mi`, elevationGain: `${vert} ft`, avgHeartRate: 142 },
    exercises: [ex(build ? 'Trail Run' : 'Easy Run', 'cardio', { duration: `${mins} min` })],
    // Same easy pace, lower heart rate: the aerobic base doing its job.
    _cardio: { mins, miles, vert, hr: Math.round(149 - 10 * (w / TOTAL_WEEKS) + between(-1.5, 1.5)) },
  });
}

const BOULDERS = ['V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];
const ROUTES = ['5.10c', '5.10d', '5.11a', '5.11b', '5.11c'];

function gymClimb(w) {
  const limit = w % 2 === 0;
  const lift = Math.min(2, Math.floor(w / 7));
  // Top boulder grade climbs V5 → V7 over the window; the rest sit below it.
  const top = 3 + Math.min(3, Math.floor((w / TOTAL_WEEKS) * 3.4));
  const pitches = limit
    ? Array.from({ length: 6 }, (_, i) => {
        const g = BOULDERS[i === 5 ? top : top - 1 - Math.floor(rand() * 2)];
        return ex(`Problem — ${pick(['cave', 'slab', 'arete', 'roof', 'comp wall'])}`, 'climbing',
          { climbStyle: 'boulder', grade: g, ascentStyle: i === 5 ? 'redpoint' : pick(['flash', 'redpoint', 'attempt']) });
      })
    : Array.from({ length: 5 }, () => {
        const g = ROUTES[Math.min(ROUTES.length - 1, Math.floor(rand() * 3) + lift)];
        return ex(`Lead — ${pick(['Orange 12', 'Blue tufa', 'Arete line', 'Overhang 3', 'Crack sim'])}`, 'climbing',
          { climbStyle: 'sport', grade: g, ascentStyle: pick(['flash', 'redpoint', 'redpoint', 'attempt']) });
      });
  return event(w, 3, 'climb', {
    type: 'climbing', sport: 'climbing',
    title: limit ? 'Limit Bouldering + Hangboard' : 'Lead Endurance 4×4s',
    subtitle: limit ? 'Short, hard, full rest' : 'Pump management for long pitches',
    start_time: '6:00 PM', end_time: '8:00 PM', estimated_duration: 120,
    difficulty: limit ? 4 : 3,
    description: limit
      ? 'Max-effort problems with four minutes between attempts, then a short hangboard block while the fingers are warm.'
      : 'Four routes back-to-back, four rounds. Clip and keep moving; shake on the jugs. Builds the forearm endurance a long alpine rock day demands.',
    location: 'Central Rock Gym — Glastonbury',
    tags: ['climbing', limit ? 'power' : 'endurance'],
    equipment: ['harness', 'shoes', 'chalk'],
    warmup: [ex('Easy Traversing', 'skill', { duration: '10 min', definitionId: 'easy-traversing' })],
    exercises: limit
      ? [...pitches, ex('Hangboard Main Block', 'skill', { sets: 6, duration: '10s on, 5s off', weight: '20mm edge', definitionId: 'hangboard-main-block' })]
      : pitches,
  });
}

function recoverySpin(w) {
  return event(w, 4, 'spin', {
    type: 'cardio', sport: 'biking',
    title: 'Recovery Spin',
    start_time: '6:30 AM', estimated_duration: 45,
    difficulty: 1,
    description: 'Flush the legs before the weekend. Zone 1, high cadence.',
    location: 'Home trainer',
    tags: ['recovery'],
    cardio_targets: { distance: '13 mi', avgHeartRate: 118 },
    exercises: [ex('Easy Spin', 'cardio', { duration: '45 min' })],
    _cardio: { mins: 45, miles: +between(12, 14).toFixed(1), vert: 0, hr: Math.round(between(112, 122)) },
  });
}

const HIKES = [
  ['Sleeping Giant — Tower Trail repeats', 'Sleeping Giant State Park, Hamden'],
  ['Mt. Everett & Race Brook Falls', 'Mt. Everett, Mount Washington MA'],
  ['Bear Mountain via Undermountain Trail', 'Salisbury, CT'],
  ['Mt. Washington — Tuckerman Ravine', 'Pinkham Notch, NH'],
  ['Franconia Ridge Loop', 'Franconia Notch, NH'],
  ['Mt. Greylock — Hopper Trail', 'Williamstown, MA'],
  ['Presidential Traverse (north half)', 'Appalachia trailhead, NH'],
];

function packHike(w) {
  const p = w / TOTAL_WEEKS;
  const [title, location] = HIKES[w % HIKES.length];
  const mins = round5(between(210, 270) + 120 * p);
  const vert = round5(between(3200, 4200) + 2600 * p);
  const miles = +between(9, 12 + 5 * p).toFixed(1);
  const pack = round5(25 + 20 * p);
  return event(w, 5, 'long', {
    type: 'cardio', sport: 'other',
    title,
    subtitle: `Long day — ${pack} lb pack`,
    start_time: '6:00 AM', estimated_duration: mins,
    difficulty: 4,
    description: `The week's long day. Carry ${pack} lb (water jugs — dump them at the top to spare the knees). Steady zone 2 on the climbs, eat every 45 minutes, practice the transitions you'll do in the mountains.`,
    location,
    tags: ['long day', 'vert', 'weighted pack'],
    equipment: ['pack', 'poles', 'water jugs'],
    cardio_targets: { distance: `${miles} mi`, elevationGain: `${vert.toLocaleString('en-US')} ft`, avgHeartRate: 138 },
    exercises: [ex('Weighted Pack Hike', 'cardio', { duration: `${mins} min`, weight: `${pack} lb` })],
    _cardio: { mins, miles, vert, hr: Math.round(between(132, 142)) },
  });
}

const CRAGS = [
  { title: 'The Gunks — High Exposure & CCK', location: 'Trapps, Gunks NY', pitches: [['High Exposure', '5.6', 'trad'], ['High Exposure P2', '5.6', 'trad'], ['CCK', '5.7', 'trad'], ['CCK P2', '5.7', 'trad'], ['Bonnie\'s Roof', '5.9', 'trad']] },
  { title: 'Cathedral Ledge — Thin Air', location: 'North Conway, NH', pitches: [['Thin Air P1', '5.6', 'trad'], ['Thin Air P2', '5.6', 'trad'], ['Thin Air P3', '5.6', 'trad'], ['Recompense P1', '5.9', 'trad']] },
  { title: 'Ragged Mountain — Wiessner Woods', location: 'Southington, CT', pitches: [['Vector', '5.7', 'trad'], ['Wiessner Slab', '5.4', 'trad'], ['Subline', '5.8', 'trad'], ['Aid Crack', '5.10a', 'trad']] },
];

function cragDay(w) {
  const crag = CRAGS[w % CRAGS.length];
  return event(w, 5, 'long', {
    type: 'outdoor-climbing', sport: 'climbing',
    title: crag.title,
    subtitle: 'Multipitch mileage',
    start_time: '7:00 AM', end_time: '5:00 PM', estimated_duration: 480,
    difficulty: 3,
    description: 'Trad mileage on moderate terrain — fast transitions, simul-rappels, efficient anchors. Speed on easy ground is what buys time high on a big route.',
    location: crag.location,
    tags: ['trad', 'multipitch', 'outdoor'],
    equipment: ['rack', 'double ropes', 'helmet'],
    climbing_targets: { totalPitches: crag.pitches.length },
    exercises: crag.pitches.map(([name, grade, style]) =>
      ex(name, 'climbing', { climbStyle: style, grade, ascentStyle: pick(['flash', 'flash', 'follow']) })),
  });
}

function z2Ride(w) {
  const mins = round5(between(90, 150));
  const miles = +(mins / 60 * between(15, 17)).toFixed(1);
  const vert = round5(between(1400, 2600));
  return event(w, 6, 'ride', {
    type: 'cardio', sport: 'biking',
    title: 'Zone 2 Ride',
    subtitle: 'Back-to-back aerobic volume',
    start_time: '8:00 AM', estimated_duration: mins,
    difficulty: 2,
    description: 'Second long aerobic day on tired legs, low impact. Keep it conversational.',
    location: 'Shoreline loop — Guilford & Madison',
    tags: ['zone 2', 'bike'],
    cardio_targets: { distance: `${miles} mi`, elevationGain: `${vert.toLocaleString('en-US')} ft` },
    exercises: [ex('Road Ride', 'cardio', { duration: `${mins} min` })],
    _cardio: { mins, miles, vert, hr: Math.round(between(128, 138)) },
  });
}

function mobility(w) {
  return event(w, 0, 'mobility', {
    type: 'yoga',
    title: 'Mobility & Core',
    subtitle: 'Rest day reset',
    start_time: '7:00 PM', end_time: '7:40 PM', estimated_duration: 40,
    difficulty: 1,
    description: 'Hips, T-spine and ankles — the joints a heavy pack and big boots punish.',
    location: 'Home',
    tags: ['mobility', 'recovery'],
    exercises: [
      ex('90/90 Hip Stretch', 'stretch', { duration: '3 min', definitionId: '90-90-hip-stretch' }),
      ex('Thoracic Extension over Foam Roller', 'stretch', { duration: '4 min', definitionId: 'thoracic-extension-over-foam-roller' }),
      ex('Calf/Ankle Dorsiflexion Stretch', 'stretch', { duration: '2 min', definitionId: 'calf-ankle-dorsiflexion-stretch' }),
      ex('Dead Bug', 'strength', { sets: 3, reps: '10', definitionId: 'dead-bug' }),
      ex('Side Plank Twist', 'strength', { sets: 2, reps: '12', definitionId: 'side-plank-twist' }),
    ],
  });
}

function iceToolDay(w) {
  return event(w, 4, 'ice', {
    type: 'climbing', sport: 'climbing',
    title: 'Drytooling & Tool Hangs',
    subtitle: 'Ice season is coming',
    start_time: '6:00 PM', end_time: '7:30 PM', estimated_duration: 90,
    difficulty: 3,
    description: 'Tool-specific grip strength and lock-offs, then mixed laps on the gym drytool wall in crampons.',
    location: 'Central Rock Gym — Glastonbury',
    tags: ['ice', 'mixed', 'grip'],
    equipment: ['ice tools', 'crampons', 'helmet'],
    exercises: [
      ex('Ice Tool Hang', 'skill', { sets: 5, duration: '30s', definitionId: 'ice-tool-hang' }),
      ex('Drytool lap — left line', 'climbing', { climbStyle: 'ice-mixed', grade: 'M4', ascentStyle: 'redpoint' }),
      ex('Drytool lap — roof', 'climbing', { climbStyle: 'ice-mixed', grade: 'M5', ascentStyle: 'attempt' }),
    ],
  });
}

function tetonTrip() {
  event(W_TETON, 3, 'approach', {
    type: 'cardio', sport: 'other',
    title: 'Approach to the Lower Saddle',
    subtitle: 'Grand Teton — day 1',
    start_time: '7:00 AM', estimated_duration: 420,
    difficulty: 4,
    description: 'Lupine Meadows to the Lower Saddle with full kit. Camp at 11,600 ft, melt snow, early bed.',
    location: 'Grand Teton National Park, WY',
    tags: ['approach', 'trip', 'altitude'],
    equipment: ['overnight pack', 'tent', 'stove'],
    cardio_targets: { distance: '7 mi', elevationGain: '4,900 ft' },
    exercises: [ex('Approach Hike', 'cardio', { duration: '420 min', weight: '45 lb' })],
    _cardio: { mins: 405, miles: 7.1, vert: 4950, hr: 136 },
  });
  event(W_TETON, 4, 'summit', {
    type: 'outdoor-climbing', sport: 'climbing',
    title: 'Grand Teton — Upper Exum Ridge',
    subtitle: 'Summit day',
    start_time: '3:30 AM', end_time: '6:00 PM', estimated_duration: 870,
    difficulty: 5,
    description: 'Alpine start from the Lower Saddle, Wall Street ledge to the ridge, simul-climbed most of it. Summit 13,775 ft at 11:40, Owen-Spalding rappels down.',
    location: 'Grand Teton National Park, WY',
    tags: ['alpine', 'objective', 'summit'],
    equipment: ['alpine rack', 'single rope', 'helmet', 'approach shoes'],
    climbing_targets: { maxGrade: '5.5', totalPitches: 8 },
    exercises: [
      ex('Wall Street', 'climbing', { climbStyle: 'trad', grade: '5.4', ascentStyle: 'flash' }),
      ex('Golden Staircase', 'climbing', { climbStyle: 'trad', grade: '5.5', ascentStyle: 'flash' }),
      ex('Wind Tunnel', 'climbing', { climbStyle: 'trad', grade: '5.4', ascentStyle: 'flash' }),
      ex('Friction Pitch', 'climbing', { climbStyle: 'trad', grade: '5.5', ascentStyle: 'flash' }),
      ex('V-Pitch', 'climbing', { climbStyle: 'trad', grade: '5.5', ascentStyle: 'follow' }),
      ex('Upper ridge (simul)', 'climbing', { climbStyle: 'trad', grade: '5.4', ascentStyle: 'flash' }),
    ],
  });
}

// ── The weeks ─────────────────────────────────────────────────────────────────

for (let w = 0; w < TOTAL_WEEKS; w++) {
  const deload = w % 4 === 3;
  mobility(w);
  (w < W_ME ? strengthDay : meDay)(w);
  z2Run(w);
  if (w === W_TETON) { tetonTrip(); continue; }
  gymClimb(w);
  if (w >= W_WINTER) iceToolDay(w);
  else if (!deload) recoverySpin(w);
  (w % 3 === 1 ? cragDay : packHike)(w);
  if (!deload) z2Ride(w);
}

// ── Completion + logged actuals for everything already behind us ──────────────

const completions = [];
const sessions = [];
const setLogs = [];
const cardioLogs = [];

const parseMins = t => {
  const m = t.match(/^(\d+):(\d+) (AM|PM)$/);
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2];
};

for (const e of events) {
  const past = e.date < today;
  // A missed session every few weeks — a perfect log reads as fake — but
  // never in the last fortnight, which is what the default views show.
  const recent = e._week >= WEEKS_BACK - 1;
  if (!past || (!recent && e.type !== 'outdoor-climbing' && rand() < 0.07)) continue;

  const startMin = e.start_time ? parseMins(e.start_time) : 7 * 60;
  const durationMin = e._cardio?.mins ?? Math.round(e.estimated_duration * between(0.9, 1.1));
  const startedAt = new Date(`${e.date}T00:00:00Z`).getTime() + (startMin + 240) * 60_000; // ET → UTC
  const finishedAt = new Date(startedAt + durationMin * 60_000).toISOString();

  completions.push({
    user_id: uid, event_id: e.id, event_date: e.date, event_title: e.title, event_type: e.type,
    is_completed: true, completed_at: finishedAt, duration_minutes: durationMin,
  });
  sessions.push({
    user_id: uid, event_id: e.id, event_date: e.date,
    started_at: new Date(startedAt).toISOString(), finished_at: finishedAt,
    total_duration_seconds: durationMin * 60,
  });

  for (const [section, list] of [['warmup', e.warmup], ['exercise', e.exercises], ['cooldown', e.cooldown]]) {
    for (const x of list) {
      const base = {
        user_id: uid, event_id: e.id, event_date: e.date, section,
        exercise_id: x.id, exercise_name: x.name, definition_id: x.definitionId ?? null, is_autofilled: false,
      };
      if (x.category === 'cardio') {
        const c = e._cardio;
        cardioLogs.push({
          ...base,
          duration_minutes: c.mins,
          distance: `${c.miles} mi`,
          elevation_gain: c.vert ? `${c.vert.toLocaleString('en-US')} ft` : null,
          avg_heart_rate: c.hr,
        });
        continue;
      }
      // A pitch is one set with its grade in the weight column (resolvePlannedSets).
      if (x.category === 'climbing') {
        setLogs.push({
          ...base, set_number: 1,
          planned_weight: x.grade ?? null, planned_reps: null, planned_duration: null,
          actual_weight: x.grade ?? null, actual_reps: null, actual_duration: null,
        });
        continue;
      }
      const n = x.sets ?? 1;
      for (let s = 1; s <= n; s++) {
        // The last set of a heavy lift sometimes comes up a rep short.
        const reps = x.reps && /^\d+$/.test(x.reps) && s === n && x.weight && rand() < 0.25
          ? String(+x.reps - 1) : x.reps ?? null;
        setLogs.push({
          ...base, set_number: s,
          planned_weight: x.weight ?? null, planned_reps: x.reps ?? null, planned_duration: x.duration ?? null,
          actual_weight: x.weight ?? null, actual_reps: reps, actual_duration: x.duration ?? null,
        });
      }
    }
  }
}

// ── Objectives & blocks ──────────────────────────────────────────────────────

// Every objective date moves with the window, so a re-run months from now
// still has the achieved trip behind and the active objectives ahead: the ice
// route closes out the winter block, Denali sits ~8 months out.
const tetonDate = dayOf(W_TETON, 4);
const pinnacleDate = dayOf(W_WINTER + 7, 5);
const denaliDate = dayOf(WEEKS_BACK + 35, 5);
const monthYear = d => new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const objectives = [
  { id: OBJ.teton, name: 'Grand Teton — Upper Exum Ridge', discipline: 'alpine', status: 'achieved', target_date: tetonDate,
    notes: 'Classic 5.5 alpine ridge, car-to-car in two days. Summited — fast and clean on the simul-climbing.' },
  { id: OBJ.pinnacle, name: 'Pinnacle Gully, Mt. Washington', discipline: 'ice', status: 'active', target_date: pinnacleDate,
    notes: 'WI3 classic in Huntington Ravine. Lead every pitch; be comfortable on 60° ice with a winter pack.' },
  { id: OBJ.denali, name: 'Denali — Cassin Ridge', discipline: 'alpine', status: 'active', target_date: denaliDate,
    notes: '9,000 ft of Alaska Grade 5 on the south face. Needs a huge aerobic engine, multi-day heavy-pack resilience, and WI4/M4 competence at altitude.' },
].map(o => ({ ...o, user_id: uid, required_capabilities: [] }));

const blocks = [
  { id: BLOCK.base, objective_id: OBJ.teton, name: 'Aerobic Base', phase: 'base',
    intent: 'Build the zone 2 engine and raw strength before the Teton trip. Volume up, intensity down.',
    start_date: iso(mondayOf(0)), end_date_exclusive: iso(mondayOf(W_ME)),
    weekly_targets: { cardioMinutes: 330, vert: { value: 5000, unit: 'ft' }, strengthSessions: 1, climbingSessions: 1, longSessionMinutes: 180 } },
  { id: BLOCK.me, objective_id: OBJ.denali, name: 'Muscular Endurance', phase: 'build',
    intent: 'Convert strength into the ability to climb steep ground under a heavy pack for hours.',
    start_date: iso(mondayOf(W_ME)), end_date_exclusive: iso(mondayOf(W_WINTER)),
    weekly_targets: { cardioMinutes: 420, vert: { value: 7500, unit: 'ft' }, strengthSessions: 1, climbingSessions: 2, longSessionMinutes: 240 } },
  { id: BLOCK.winter, objective_id: OBJ.pinnacle, name: 'Winter Alpine Prep', phase: 'build',
    intent: 'Tool-specific strength and cold-weather mileage ahead of Huntington Ravine.',
    start_date: iso(mondayOf(W_WINTER)), end_date_exclusive: iso(mondayOf(W_WINTER + 8)),
    weekly_targets: { cardioMinutes: 400, vert: { value: 8000, unit: 'ft' }, strengthSessions: 1, climbingSessions: 2, longSessionMinutes: 300 } },
].map(b => ({ ...b, user_id: uid }));

// ── Analytics dashboard (12-column grid) ─────────────────────────────────────

const RANGE = { kind: 'rolling', days: 112 };
const tile = (id, layout, spec) => ({ user_id: uid, id: `showcase-${id}`, ...layout, spec: { version: 1, ...spec } });
const tiles = [
  tile('vert-month', { x: 0, y: 0, w: 3, h: 3 }, {
    title: 'Vert, last 4 weeks', chartType: 'kpi', range: { kind: 'rolling', days: 28 }, bucket: 'total',
    displayUnit: 'ft', series: [{ id: 's1', measure: 'elevation-gain' }] }),
  tile('sessions-month', { x: 3, y: 0, w: 3, h: 3 }, {
    title: 'Sessions, last 4 weeks', chartType: 'kpi', range: { kind: 'rolling', days: 28 }, bucket: 'total',
    series: [{ id: 's1', measure: 'session-count' }] }),
  tile('time-by-sport', { x: 6, y: 0, w: 6, h: 6 }, {
    title: 'Weekly training time by sport', chartType: 'stacked-bar', range: RANGE, bucket: 'week',
    series: [{ id: 's1', measure: 'training-time', groupBy: 'sport' }] }),
  tile('weekly-vert', { x: 0, y: 3, w: 6, h: 5 }, {
    title: 'Weekly vertical gain', chartType: 'area', range: RANGE, bucket: 'week', displayUnit: 'ft',
    series: [{ id: 's1', measure: 'elevation-gain' }] }),
  tile('strength-1rm', { x: 6, y: 6, w: 6, h: 5 }, {
    title: 'Max strength block — est. 1RM', chartType: 'line', bucket: 'week',
    range: { kind: 'fixed', startDate: iso(mondayOf(0)), endDateExclusive: iso(mondayOf(W_ME)) },
    series: [{ id: 's1', measure: 'est-1rm', filters: { exerciseNames: ['Back Squat', 'Trap Bar Deadlift'] }, groupBy: 'exercise' }] }),
  tile('boulder-grade', { x: 0, y: 8, w: 6, h: 4 }, {
    title: 'Hardest boulder', chartType: 'line', range: RANGE, bucket: 'week',
    series: [{ id: 's1', measure: 'max-grade', filters: { gradeScale: 'boulder' } }] }),
  tile('aerobic-hr', { x: 6, y: 11, w: 6, h: 4 }, {
    title: 'Zone 2 heart rate', chartType: 'line', range: RANGE, bucket: 'week',
    series: [{ id: 's1', measure: 'avg-hr', filters: { sports: ['running'] } }] }),
];

// ── Profile: the persona, and no onboarding chrome in the shots ──────────────
// Every tip id in src/lib/onboarding/tips/ is marked seen (read from source so
// a new tip is covered without touching this file). template_copied_at and
// coach_goal tick two of the three setup rows; the third needs a real
// Anthropic key, so that card still shows until dismissed with its ×.

const TIPS_DIR = 'src/lib/onboarding/tips';
const tipIds = readdirSync(TIPS_DIR)
  .filter(f => f.endsWith('.ts'))
  .flatMap(f => [...readFileSync(`${TIPS_DIR}/${f}`, 'utf8').matchAll(/^\s+id: '([a-z0-9-]+)'/gm)].map(m => m[1]));
const nowIso = now.toISOString();

const profile = {
  display_name: 'Alex Moreau',
  avatar_key: 'ibex',
  coach_goal: `Climb the Cassin Ridge on Denali in ${monthYear(denaliDate)}. Lead Pinnacle Gully in ${monthYear(pinnacleDate)} on the way.`,
  coach_context: `Alpinist based in New Haven, CT. Summited the Grand Teton via the Upper Exum in ${monthYear(tetonDate)}. Trains 6 days a week around a desk job: early mornings on weekdays, long mountain days on Saturdays. Leads 5.11 sport, 5.9 trad, WI3. Left knee gets cranky on long descents — poles and step-down work help.`,
  max_hr: 192,
  threshold_hr: 171,
  template_copied_at: nowIso,
  tips_seen: Object.fromEntries(tipIds.map(id => [id, nowIso])),
};

// ── Write ─────────────────────────────────────────────────────────────────────

await insert('exercise_definitions', DEFINITIONS.map(d => ({ ...d, user_id: uid })));
await insert('workout_events', events.map(({ _week, _cardio, ...e }) => e));
await insert('workout_completions', completions);
await insert('workout_sessions', sessions);
await insert('workout_set_logs', setLogs);
await insert('workout_cardio_logs', cardioLogs);
await insert('objectives', objectives);
await insert('training_blocks', blocks);
await insert('analytics_tiles', tiles);
await rest(`/rest/v1/profiles?id=eq.${uid}`, { method: 'PATCH', body: profile });

console.log([
  `showcase seeded for agent@apex.local (${iso(mondayOf(0))} → ${iso(mondayOf(TOTAL_WEEKS))}):`,
  `  ${events.length} events, ${completions.length} completed`,
  `  ${setLogs.length} set logs, ${cardioLogs.length} cardio logs`,
  `  ${objectives.length} objectives, ${blocks.length} training blocks, ${DEFINITIONS.length} new definitions`,
  `  ${tiles.length} analytics tiles`,
  `  profile: ${profile.display_name}, ${tipIds.length} tips marked seen`,
].join('\n'));
