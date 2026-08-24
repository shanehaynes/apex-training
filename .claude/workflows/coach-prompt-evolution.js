export const meta = {
  name: 'coach-prompt-evolution',
  description: 'AVO-style bounded search over the coach prompt, scored per-dimension by the eval suite',
  whenToUse:
    'Evolve src/lib/coach/prompt.ts against `npm run eval`. Needs ANTHROPIC_API_KEY in the ' +
    'environment (evals/README.md) and real token spend — run only when the user asked for an ' +
    'evolution run. Args: {generations?: number (default 2), variants?: number (default 3), ' +
    'model?: string (eval --model arg; empty = harness default)}. Returns {champion, lineage}; ' +
    'apply champion.diff on a fresh db-free branch for review and save the lineage JSON to ' +
    'evals/lineage/ in that PR. Variant worktrees the harness leaves behind can be cleaned ' +
    'with `git worktree list` + `git worktree remove` afterwards.',
  phases: [
    { title: 'Baseline', detail: 'score the current prompt on every dimension' },
    { title: 'Evolve', detail: 'variant agents propose one prompt edit each, scored in isolated worktrees' },
  ],
}

// The eval suite is deliberately per-dimension, not a single score
// (evals/README.md). The judge here mirrors that: a variant wins only by
// DOMINANCE — no dimension gets worse, at least one gets strictly better.
// The plateau break below is the supervisor: when a whole generation fails
// to dominate, the search stops rather than wandering.

const generations = args?.generations ?? 2
const nVariants = args?.variants ?? 3
const model = args?.model ?? ''
const modelFlag = model ? ` -- --model ${model}` : ''

const DIMS_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: { pass: { type: 'number' }, fail: { type: 'number' }, other: { type: 'number' } },
    required: ['pass', 'fail'],
  },
}
const BASELINE_SCHEMA = {
  type: 'object',
  required: ['dims', 'failures'],
  properties: {
    dims: DIMS_SCHEMA,
    failures: { type: 'array', items: { type: 'string' } },
    anomalies: { type: 'string' },
  },
}
const VARIANT_SCHEMA = {
  type: 'object',
  required: ['dims', 'editSummary', 'diff'],
  properties: {
    dims: DIMS_SCHEMA,
    editSummary: { type: 'string' },
    diff: { type: 'string' },
    anomalies: { type: 'string' },
  },
}

const rate = d => (d.pass + d.fail > 0 ? d.pass / (d.pass + d.fail) : 1)
function dominates(candidate, incumbent) {
  let strictlyBetter = false
  for (const dim of Object.keys(incumbent)) {
    const c = candidate[dim]
    if (!c) return false
    if (rate(c) < rate(incumbent[dim])) return false
    if (rate(c) > rate(incumbent[dim])) strictlyBetter = true
  }
  return strictlyBetter
}

const scoreInstructions =
  `Then run \`npm run eval${modelFlag}\` and read the NEWEST evals/results/*.json it wrote. ` +
  `Report dims as that file's aggregate.passRateByDimension, verbatim. If the run itself ` +
  `errors (missing ANTHROPIC_API_KEY, network), say so in anomalies and report dims as {}.`

phase('Baseline')
const baseline = await agent(
  `You are the baseline scorer for an evolutionary search over the Apex coach prompt. ` +
    `Read evals/README.md first. Do not edit anything. ${scoreInstructions} ` +
    `Also list each failing case as "caseId (dimension): one-line reason" in failures.`,
  { label: 'baseline', schema: BASELINE_SCHEMA },
)
if (!baseline || Object.keys(baseline.dims).length === 0) {
  return { error: `Baseline eval run failed — nothing to climb. ${baseline?.anomalies ?? ''}` }
}
log(`baseline: ${Object.entries(baseline.dims).map(([d, v]) => `${d} ${v.pass}/${v.pass + v.fail}`).join(', ')}`)

// The variation-operator angles, one per variant index. Prompt-varied
// diversity: each operator attacks the failures a different way.
const ANGLES = [
  'Target the single worst dimension: read its failing transcripts under evals/results/transcripts/ and fix the specific instruction the coach ignored or misread.',
  'Tighten wording: find the prompt section the failures implicate and make its rule impossible to misread — shorter and sharper, not longer.',
  'Restructure: move or regroup the implicated guidance so the rule and its exception sit together; change meaning nowhere.',
  'Add one worked example to the section the failures implicate, in the exact shape the eval cases exercise.',
]

let champion = { dims: baseline.dims, diff: null, editSummary: 'baseline (unmodified prompt)' }
const lineage = [{ gen: 0, variant: 'baseline', dims: baseline.dims, editSummary: champion.editSummary }]

for (let gen = 1; gen <= generations; gen++) {
  const results = await parallel(
    Array.from({ length: nVariants }, (_, i) => () =>
      agent(
        `You are ONE variation operator in a bounded evolutionary search over the Apex coach ` +
          `prompt (AVO-style: you decide what to inspect, change and test; the harness scores you). ` +
          `You are in an isolated git worktree — run \`npm ci --no-audit --no-fund\` first.\n\n` +
          `Angle for this variant: ${ANGLES[i % ANGLES.length]}\n\n` +
          `Current champion prompt state:${champion.diff ? `\napply this diff to src/lib/coach/prompt.ts before your own edit:\n${champion.diff}` : ' the committed prompt, unmodified.'}\n\n` +
          `Champion per-dimension results: ${JSON.stringify(champion.dims)}\n` +
          `Baseline failures:\n${baseline.failures.map(f => `- ${f}`).join('\n')}\n` +
          `Lineage so far (do not repeat a failed edit): ${JSON.stringify(lineage.map(l => ({ gen: l.gen, edit: l.editSummary, dims: l.dims })))}\n\n` +
          `Read evals/README.md, then make ONE targeted edit to src/lib/coach/prompt.ts and ` +
          `NOTHING else — schemas.ts, tools.ts and model.ts are off limits (the results file ` +
          `hashes the behavior surface, so any other edit is visible). Respect the data ` +
          `conventions already encoded in prompt.ts (one movement per entry, per-side reps for ` +
          `unilateral work). ${scoreInstructions}\n\n` +
          `Report diff as \`git diff src/lib/coach/prompt.ts\` INCLUDING the champion diff you ` +
          `applied (the full delta from the committed file), and editSummary as one sentence.`,
        { label: `g${gen}v${i}`, phase: 'Evolve', isolation: 'worktree', schema: VARIANT_SCHEMA },
      ),
    ),
  )

  const winners = results.filter(Boolean).filter(v => Object.keys(v.dims).length > 0 && dominates(v.dims, champion.dims))
  for (const v of results.filter(Boolean)) {
    lineage.push({ gen, variant: v.editSummary, dims: v.dims, editSummary: v.editSummary, kept: winners.includes(v) })
  }
  if (winners.length === 0) {
    log(`generation ${gen}: no variant dominates the champion — plateau, stopping`)
    break
  }
  winners.sort((a, b) => {
    const avg = v => Object.values(v.dims).reduce((s, d) => s + rate(d), 0) / Object.keys(v.dims).length
    return avg(b) - avg(a)
  })
  champion = winners[0]
  log(`generation ${gen}: new champion — ${champion.editSummary}`)
}

return {
  champion: champion.diff ? champion : { note: 'no variant beat the committed prompt; nothing to apply', dims: champion.dims },
  lineage,
}
