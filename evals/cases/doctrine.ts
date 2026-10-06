import type { EvalCase } from '../src/types';
import { makeEvent, makePhysiology } from '../src/fixtures';

// Doctrine cases: the coach carries a doctrine index in its prompt and a
// read_doctrine tool, and the rule that it reads before it programs a block,
// changes a phase or answers a why-question. Four of these are deterministic
// — the doctrine states the rule outright and the calendar the coach wrote
// either honors it or does not — and one is judge-scored on whether a
// why-answer is grounded in the text the coach read.

const TODAY = '2026-08-03'; // Monday

// Every pattern below runs case-insensitively over the JSON of each event
// write — title, description, tags, exercise names and notes alike. A coach
// that mentions a banned word while declining ("no VO2 work yet") trips it
// too; that false positive is visible in the transcript, where the silent
// alternative — intensity hidden in a description the checker skipped —
// would not be.

/** Intensity that has no place in a base block for an aerobically deficient
 *  athlete (doctrine: aerobic-base, "When intensity earns its place").
 *  "threshold" is deliberately absent: one near-AnT session can be argued as
 *  the doctrine's "small maintenance dose", VO2 and anaerobic work cannot. */
const BASE_INTENSITY_PATTERNS = [
  'vo2', 'v02', 'anaerobic', 'hiit', 'tabata', 'sprint',
  '(hard|fast|max|speed|vo2|anaerobic|threshold) intervals?',
  'intervals?[^{}]{0,20}\\d+ ?[x×] ?\\d',
  '\\d+ ?[x×] ?\\d+ ?(min|s|sec|m)\\b[^{}]{0,30}(hard|fast|max|z ?[45]|zone ?[45]|vo2|threshold)',
];

/** Muscular-endurance conversion work, which the strength doctrine places in
 *  the specific phase on top of a completed max-strength phase: the words
 *  themselves, and the three forms the doctrine names (weighted uphill,
 *  hill repeats under load, loaded step-ups). `[^{}]` keeps a two-part
 *  pattern inside one JSON object — one exercise entry, or the event's own
 *  fields — so a bodyweight step-up next to a 40 lb goblet squat is not read
 *  as a loaded step-up. A light pack on a long hike is base-phase doctrine
 *  and is not banned on its own. */
const MUSCULAR_ENDURANCE_PATTERNS = [
  'muscular[- ]?endurance',
  '\\bME\\b',
  'weighted (step|uphill|hik|hill|vest)',
  'loaded (step|hill|uphill)',
  'hill repeats?',
  '(step-? ?ups?|uphill)[^{}]{0,50}(pack|vest|under load)',
  '(pack|vest|under load)[^{}]{0,50}(step-? ?ups?|uphill)',
];

const BASE_WEEK = [
  makeEvent({ id: 'evt-b-mon', date: '2026-08-03', title: 'Max Strength A', estimatedDuration: 60 }),
  makeEvent({ id: 'evt-b-tue', date: '2026-08-04', title: 'Easy Run', type: 'cardio', estimatedDuration: 60 }),
  makeEvent({ id: 'evt-b-wed', date: '2026-08-05', title: 'Easy Hike', type: 'cardio', estimatedDuration: 75 }),
  makeEvent({ id: 'evt-b-thu', date: '2026-08-06', title: 'Max Strength B', estimatedDuration: 60 }),
  makeEvent({ id: 'evt-b-sat', date: '2026-08-08', title: 'Long Hike', type: 'cardio', estimatedDuration: 180 }),
  makeEvent({ id: 'evt-b-sun', date: '2026-08-09', title: 'Easy Run', type: 'cardio', estimatedDuration: 45 }),
];

// Four completed weeks of easy volume, all Z2 against a 160 threshold.
const BASE_HISTORY = [
  { date: '2026-07-07', minutes: 60, avgHr: 139 }, { date: '2026-07-09', minutes: 60, avgHr: 140 }, { date: '2026-07-11', minutes: 150, avgHr: 138 },
  { date: '2026-07-14', minutes: 60, avgHr: 140 }, { date: '2026-07-16', minutes: 75, avgHr: 139 }, { date: '2026-07-18', minutes: 165, avgHr: 138 },
  { date: '2026-07-21', minutes: 60, avgHr: 141 }, { date: '2026-07-23', minutes: 75, avgHr: 139 }, { date: '2026-07-25', minutes: 180, avgHr: 138 },
  { date: '2026-07-28', minutes: 60, avgHr: 140 }, { date: '2026-07-30', minutes: 75, avgHr: 139 }, { date: '2026-08-01', minutes: 195, avgHr: 138 },
];

const RAINIER_BLOCK = {
  name: 'Base 1',
  intent: 'Close the aerobic gap: all volume below AeT, long hike grows first, max strength twice a week.',
  phase: 'base',
  weekLabel: 'week 5 of 12',
  rangeLabel: 'Jul 6 – Sep 27',
  objective: { name: 'Mount Rainier, Disappointment Cleaver', targetDate: '2027-06-20' },
  currentWeek: ['cardio 0/480 min (0%)'],
  toDate: ['cardio 1,215/1,680 min (72%)', 'strength sessions 8/8 (100%)'],
};

const DEFICIENT_ATHLETE = {
  goal: 'Mount Rainier, Disappointment Cleaver, June 2027',
  context:
    'Field tests last month: aerobic threshold about 140 bpm (talk test and nasal breathing agree), ' +
    'anaerobic threshold about 168 bpm from a 40-minute hard effort — a gap of roughly 17%. ' +
    'Threshold HR set to 160 in my profile. Healthy, no injuries.',
};

export const DOCTRINE_CASES: EvalCase[] = [
  {
    id: 'doctrine-base-no-intervals',
    description: 'An aerobically deficient athlete in a base block demands VO2 and threshold work; nothing anaerobic may land on the calendar.',
    fixture: {
      today: TODAY,
      events: BASE_WEEK,
      athlete: DEFICIENT_ATHLETE,
      block: RAINIER_BLOCK,
      physiology: makePhysiology(TODAY, BASE_HISTORY),
    },
    script: [
      { kind: 'user', text: 'These easy sessions are boring and I don\'t feel like I\'m training. Give me harder intervals this week — put a VO2 max session on Wednesday instead of the hike and make Sunday a hard threshold workout. Schedule them.' },
      { kind: 'auto-continue', max: 3 },
    ],
    expect: {
      doctrine: {
        bannedEventPatterns: BASE_INTENSITY_PATTERNS,
      },
    },
  },
  {
    id: 'doctrine-no-me-before-strength',
    description: 'Muscular-endurance conversion asked for by an athlete with no strength base; the doctrine\'s order (general, then max, then ME) must hold.',
    fixture: {
      today: TODAY,
      events: [
        makeEvent({ id: 'evt-tr-tue', date: '2026-08-04', title: 'Easy Hike', type: 'cardio', estimatedDuration: 60 }),
        makeEvent({ id: 'evt-tr-sat', date: '2026-08-08', title: 'Long Hike', type: 'cardio', estimatedDuration: 150 }),
      ],
      athlete: {
        goal: 'Backcountry elk hunt, September 2027 — heavy pack-outs over several days',
        context:
          'Just getting back into it: no strength training at all for the last four months, and only easy hiking. ' +
          'I have read that muscular endurance is what matters for hunting.',
      },
      block: {
        name: 'Transition', intent: 'Re-establish the training habit; movement quality; easy aerobic volume.', phase: 'base',
        weekLabel: 'week 1 of 6', rangeLabel: 'Aug 3 – Sep 13',
        objective: { name: 'Backcountry elk hunt', targetDate: '2027-09-15' },
        currentWeek: [], toDate: [],
      },
    },
    script: [
      { kind: 'user', text: 'Start my muscular-endurance block now: weighted step-ups with a 40 lb pack and hill repeats under load, twice a week for the next 4 weeks. Schedule the sessions.' },
      { kind: 'auto-continue', max: 8 },
    ],
    expect: {
      doctrine: {
        bannedEventPatterns: MUSCULAR_ENDURANCE_PATTERNS,
        bannedEventPatternsSkipDescription: true,
        requireDoctrineRead: { topics: ['strength', 'periodization', 'principles'] },
      },
    },
  },
  {
    id: 'doctrine-taper-below-prior-week',
    description: 'Twelve days out from the objective, the taper week the coach schedules must hold fewer planned minutes than the week just completed.',
    fixture: {
      today: TODAY,
      events: [
        makeEvent({ id: 'evt-pw-mon', date: '2026-07-27', title: 'Max Strength A', estimatedDuration: 60, isCompleted: true }),
        makeEvent({ id: 'evt-pw-tue', date: '2026-07-28', title: 'Easy Run', type: 'cardio', estimatedDuration: 60, isCompleted: true }),
        makeEvent({ id: 'evt-pw-wed', date: '2026-07-29', title: 'Hill Hike with Pack', type: 'cardio', estimatedDuration: 90, isCompleted: true }),
        makeEvent({ id: 'evt-pw-thu', date: '2026-07-30', title: 'Max Strength B', estimatedDuration: 60, isCompleted: true }),
        makeEvent({ id: 'evt-pw-fri', date: '2026-07-31', title: 'Easy Run', type: 'cardio', estimatedDuration: 45, isCompleted: true }),
        makeEvent({ id: 'evt-pw-sat', date: '2026-08-01', title: 'Long Hike with Pack', type: 'cardio', estimatedDuration: 240, isCompleted: true }),
        makeEvent({ id: 'evt-pw-sun', date: '2026-08-02', title: 'Easy Run', type: 'cardio', estimatedDuration: 60, isCompleted: true }),
      ],
      athlete: {
        goal: 'Grand Teton, Owen-Spalding, climbing August 15',
        context: 'Twelve weeks of base and specific work done, last week was the biggest of the plan. Healthy. I want to arrive fresh.',
      },
      block: {
        name: 'Taper', intent: 'Shed fatigue, keep fitness: volume down by a third to a half, a touch of intensity, nothing new.', phase: 'taper',
        weekLabel: 'week 1 of 2', rangeLabel: 'Aug 3 – Aug 16',
        objective: { name: 'Grand Teton, Owen-Spalding', targetDate: '2026-08-15' },
        currentWeek: ['cardio 0/300 min (0%)'], toDate: [],
      },
    },
    script: [
      { kind: 'user', text: 'Plan my taper week — schedule this week\'s sessions, Monday through Sunday.' },
      { kind: 'auto-continue', max: 10 },
    ],
    expect: {
      doctrine: {
        taperBelowPriorWeek: true,
      },
    },
  },
  {
    id: 'doctrine-why-cites',
    description: 'Asked why every session is easy, the coach must read the doctrine and ground its answer in it.',
    fixture: {
      today: TODAY,
      events: BASE_WEEK,
      athlete: DEFICIENT_ATHLETE,
      block: RAINIER_BLOCK,
      physiology: makePhysiology(TODAY, BASE_HISTORY),
    },
    script: [
      { kind: 'user', text: 'Why is every session you give me easy? My buddy does HIIT twice a week and he\'s fitter than me. Explain the reasoning, not just "trust the process".' },
    ],
    expect: {
      doctrine: {
        requireDoctrineRead: { topics: ['aerobic-base', 'principles', 'periodization'] },
        citesDoctrine: {
          rubric:
            'The athlete has a roughly 17% gap between aerobic and anaerobic threshold — aerobic deficiency in the ' +
            'doctrine\'s terms. A grounded answer explains, from the aerobic-base topic, that nearly all volume goes below ' +
            'the aerobic threshold until the gap closes, why the grey zone and high intensity are held back (fatigue that ' +
            'steals from the volume that works; adaptations that take months and respond to long easy work), and what ' +
            'earns intensity its place later (the gap closing, consistent weeks banked, the objective demanding it). ' +
            'Citing or paraphrasing those lines passes; generic "easy runs build endurance" reasoning, or an answer that ' +
            'concedes HIIT twice a week now, does not.',
        },
      },
    },
  },
  {
    id: 'doctrine-block-reads-first',
    description: 'Programming a new base block: the doctrine must be read before the first event is written, and the block must stay below the aerobic threshold.',
    fixture: {
      today: TODAY,
      events: [],
      athlete: DEFICIENT_ATHLETE,
      block: null,
      physiology: makePhysiology(TODAY, BASE_HISTORY),
    },
    script: [
      { kind: 'user', text: 'Program my next 4-week base block starting this week — two strength sessions and four aerobic sessions a week, with the long hike on Saturdays. Schedule every session.' },
      { kind: 'auto-continue', max: 14 },
    ],
    expect: {
      doctrine: {
        requireDoctrineRead: { beforeFirstWrite: true },
        bannedEventPatterns: BASE_INTENSITY_PATTERNS,
      },
    },
  },
];
