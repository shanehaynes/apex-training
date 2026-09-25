# A03 · Doctrine: the coach's training philosophy as a compiled curriculum

## Goal
Write the training doctrine the coach will reason from, as eight `.ts` modules under
`src/lib/coach/doctrine/`, with an index, a reader, a citation-ready document list, and a
tool schema. Original synthesis only: the ideas of the Uphill Athlete school (Steve House,
Scott Johnston) and Tony Yaniro's climbing-specific training, in your own words, structured
so a coach can cite a line and act on it. Nothing imports it yet; the next wave wires the
index into the prompt and the tool into the loop.

Why: the coach holds no methodology. Its programming judgment is whatever the base model
believes about training. The athlete wants a coach that prescribes one coherent method —
aerobic base first, strength before specific strength, structured periodization toward a
mountain objective — and can say why.

## Hard rules on content
- **No quotation and no paraphrase close enough to be one.** Do not reproduce tables,
  protocols by their book names, or phrasing from any book, article or website. Write the
  ideas as a coach who has internalized them would explain them. Where a concept has a
  common name (aerobic deficiency, muscular endurance, max strength, contact strength), use
  the name; do not name book titles or chapters.
- Attribute schools of thought sparingly and generically: "the Uphill Athlete approach",
  "Yaniro's view on strength for climbers". Never invent specific numbers as if they were the
  method's canon; where a range is a widely held rule of thumb (e.g. weekly volume
  progression, max-strength rep ranges, recovery-week frequency), state it as a range and
  mark it as a guideline.
- No `<` or `>` characters anywhere in the text (the prompt wraps user data in tagged blocks
  and strips angle brackets from user text; the doctrine must never look like a tag).
- Terse, prescriptive, numbered where the method is sequential. A coach reads this under
  time pressure. Each topic is 1,200–2,600 words; the whole set stays under 80,000
  characters (a chars/4 token estimate of ~20k tokens). The index stays under 4,000
  characters.

## Topics and what each must cover
Each topic module exports one `DoctrineTopic` (see the contract) whose `text` has these
sections in order: a two-sentence framing; the body (subsections with short headings); a
final section `How the coach applies this` (5–10 imperative bullets the coach can follow when
programming or answering); and `Signals that contradict this` (3–8 bullets: what in the
athlete's data or words should make the coach question the prescription). Citations will land
on those last two sections, so make each bullet a complete, self-standing sentence.

1. `principles` — Training versus exercising; continuity, gradualness and modulation as the
   three load principles; specificity and individuality; the capacity hierarchy (a stable
   aerobic and strength base beneath specific work); "cut everything that does not move the
   athlete toward the objective"; how to read attainment numbers without moralizing.
2. `aerobicBase` — Why aerobic capacity is the foundation for mountain endurance; the aerobic
   threshold (AeT) and anaerobic threshold (AnT) and how each is estimated in the field (talk
   test, nasal breathing, heart-rate drift over a long steady effort, a lab test when
   available); aerobic deficiency (a wide AeT–AnT gap) and the prescription that follows
   (most volume below AeT, avoid the moderate "grey zone" until the gap closes); how zone
   distribution should look across a base phase; volume progression and recovery weeks; when
   higher-intensity aerobic work earns its place.
3. `periodization` — The arc from transition (movement quality, general strength, low
   volume) to base (aerobic volume, max strength) to specific (event-specific capacity,
   muscular endurance, intensity that mimics the objective) to taper and peak, then recovery;
   how objective type (alpine climb, ski traverse, rock project, hunting season) shapes the
   phases; block lengths and the loading pattern within a block; what a weekly template looks
   like in each phase; how to adjust when weeks are missed (do not cram; extend).
4. `strength` — Strength for the mountain athlete: general strength in transition (movement
   quality, unilateral work, carries), max strength in base (heavy, low reps, full recovery,
   few exercises, twice a week for several weeks), conversion to muscular endurance in the
   specific phase (weighted uphill work, high-rep loaded step-ups, hill repeats), core and
   posterior chain as prerequisites rather than accessories; strength never replaces aerobic
   work and is scheduled so it does not blunt it.
5. `climbing` — Yaniro's stance: climbers should train strength first and deliberately, not
   accumulate it by climbing alone; finger and contact strength through structured hangboard
   work (max hangs, progressive load, long rest); power through campus and limit bouldering
   when the base exists; working to failure as a planned tool with a purpose and a recovery
   cost, not a habit; capacity on easy terrain (long, continuous, low-intensity climbing) as
   the aerobic analogue; tendons and skin adapt slower than muscle, so progression is
   conservative; how climbing-specific work sits inside an alpine periodization (rock
   objectives push it forward; alpine objectives keep the aerobic base dominant).
6. `recovery` — Sleep, fueling, and the monitoring signals the app can see: resting HR, HRV
   trend, heart-rate drift on steady efforts (aerobic decoupling as a fitness signal), the
   acute-to-chronic load ratio and why a spike matters; planned deloads; overreaching versus
   overtraining and the difference between soreness and injury (the app's safety rules
   already draw that line — restate it consistently); illness rules (train below the neck,
   rest below); consistency beats heroics.
7. `mobility` — Mobility as a baseline constraint, not a decoration: the ranges climbing,
   skiing and steep hiking demand (hips, ankles, thoracic spine, shoulders), a short daily
   minimum, how mobility work is placed around strength and aerobic sessions, and when a
   restriction is a mobility problem versus a strength or pain problem (which is not the
   coach's to diagnose).
8. `athleteIdeal` — This athlete's own physical ideal, written for the coach. Use these
   facts; do not embellish: the model is the dancer and the brawler unified — explosive
   strength to move mass, with the coordination, proprioception and precision for complex
   movement. The climber-alpinist embodies it: technical delicacy and raw power are both
   required. The aesthetic ideal is the gymnast or the alpinist, not the bodybuilder; mass
   display at the expense of movement quality is a failure. Leg strength serves distance,
   load and delicate movement; upper-body strength serves bodyweight precision; core and
   posterior chain are the non-negotiable foundation and the current development focus;
   full mobility is a baseline constraint. Nothing decorative or vestigial: every session
   serves the movement model. Primary pursuits: climbing (rock, ice, alpine), backcountry
   skiing, trail running, backcountry hunting; interested in jiu-jitsu, paragliding and
   whitewater later. The athlete's level, for calibration: multi-pitch trad to 5.9 for 16
   pitches in a day, multi-pitch WI4 ice, solo couloirs and long alpine ridges with
   6,000 ft days, two-day alpine routes. Training is the servant of the pursuits, not the
   other way round.

## Interface contract (the next wave imports exactly this — do not rename)
- `src/lib/coach/doctrine/types.ts`: `export interface DoctrineTopic { id: DoctrineTopicId; title: string; summary: string /* one sentence for the index */; text: string }`
  and `export type DoctrineTopicId = 'principles' | 'aerobic-base' | 'periodization' | 'strength' | 'climbing' | 'recovery' | 'mobility' | 'athlete-ideal'`.
- One module per topic, e.g. `src/lib/coach/doctrine/aerobicBase.ts` exporting
  `export const AEROBIC_BASE: DoctrineTopic = { id: 'aerobic-base', … }`, text as a template
  literal (escape backticks; no `${}`).
- `src/lib/coach/doctrine/index.ts` exports: `DOCTRINE_TOPICS: readonly DoctrineTopic[]`
  (fixed order as numbered above); `DOCTRINE_INDEX: string` (a compact block: a one-line
  statement that the coach prescribes this method, then one line per topic
  `- <id>: <summary>`, then "Use read_doctrine(topic) for the full text before programming a
  block, changing a phase, or answering a why-question"); `readDoctrine(topic: string): string | null`;
  `doctrineDocuments(): Array<{ title: string; text: string }>` (for citation document
  blocks); and `readDoctrineToolSchema` typed `Anthropic.Tool`
  (`import type Anthropic from '@anthropic-ai/sdk'`): name `read_doctrine`, one required
  property `topic` with an `enum` equal to the ids, `additionalProperties: false`, a
  description that tells the model when to call it.
- All relative imports use `.js` specifiers (this directory joins the API import graph).
  No React, no other imports beyond `date-fns` if you need it (you should not).

## Ownership
- You own: new `src/lib/coach/doctrine/**` including `__tests__/doctrine.test.ts`.
- Do not change: anything else. In particular not `src/lib/coach/prompt.ts`, `schemas.ts`,
  `tools.ts`, `api/**`, `evals/**`, `README.md`. Shared state — never.

## Tests (`src/lib/coach/doctrine/__tests__/doctrine.test.ts`)
- Ids are unique and equal the tool schema's enum; every topic appears in `DOCTRINE_INDEX`;
  `readDoctrine` returns each topic and `null` for an unknown id.
- Budget: total `text` length under 80,000 characters; `DOCTRINE_INDEX` under 4,000; each
  topic between 6,000 and 16,000 characters.
- No `<` or `>` in any `text`, `summary` or `title`; each text contains the headings
  `How the coach applies this` and `Signals that contradict this`.

## Process
Write at high effort. Draft each topic, then reread it against the hard rules on content
(no quotation, no invented canon, no angle brackets). In DECISIONS, list any place where you
chose one school's position over another's, so Shane can review those lines first.
