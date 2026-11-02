export const meta = {
  name: 'coach-prompt-evolution',
  description: 'AVO-style bounded search over the coach prompt, scored per-dimension by the eval suite on a Claude subscription (agent-sdk backend), never an API key',
  whenToUse: 'Evolve src/lib/coach/prompt.ts against `npm run eval`. Spends the Claude SUBSCRIPTION of whoever ran `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN= in the primary checkout\'s gitignored .env.local; evals/README.md "Backends") and never an API key: every eval run is `--backend agent-sdk --judge-backend agent-sdk` with ANTHROPIC_API_KEY unset, and variant worktrees have no .env.local of their own — the runner reads the primary\'s by path. One full suite run per variant per generation, plus the baseline; run only when the user asked for an evolution run. Args: {generations?: number (default 2), variants?: number (default 3), model?: string (eval --model arg; empty = harness default), backend?: "agent-sdk" | "api" (default agent-sdk; "api" bills ANTHROPIC_API_KEY and is the production-shaped measurement), concurrency?: number (eval --concurrency, default 6, the gate\'s), lane?: string (absolute path of the orchestrating session\'s worktree; the baseline is scored there — never the primary checkout)}. Returns {champion, lineage, backend}; agent-sdk numbers are a regression-detector measurement and are not comparable to API-backend runs. A winning champion.diff is NOT applied by this workflow: a prompt change needs the eval gate and the eval-analyst agent first (docs/workflow-essentials.md). Save the lineage JSON to evals/lineage/<date>__<model>.json when a variant wins; a plateau needs no file. Remove the variant worktrees afterwards (`git worktree list` before and after; remove only the new ones).',
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
const backend = args?.backend ?? 'agent-sdk'
const concurrency = args?.concurrency ?? 6
const lane = args?.lane ?? ''
if (backend !== 'agent-sdk' && backend !== 'api') {
  return { error: `Unknown backend "${backend}" — expected "agent-sdk" (default, subscription) or "api" (ANTHROPIC_API_KEY).` }
}
if (!Number.isInteger(concurrency) || concurrency < 1) {
  return { error: `concurrency must be a positive integer, got ${JSON.stringify(concurrency)}.` }
}

// Credentials, by backend:
//   agent-sdk — the coach AND the judge run through a local Claude Code
//     process on the subscription token. The runner finds the token in
//     CLAUDE_CODE_OAUTH_TOKEN or in .env.local, and from a linked worktree it
//     falls through to the PRIMARY checkout's .env.local (evals/src/models.ts,
//     readCredential): a variant worktree cut by the harness has no .env.local
//     and needs none. Nothing here carries the token — not an env var handed to
//     an agent, not a line in a brief — so no transcript, journal or worktree
//     ever holds it. `env -u` strips the two key paths from the command's
//     environment and `--judge-backend agent-sdk` pins the judge, so an
//     ANTHROPIC_API_KEY that happens to exist cannot be billed by any run.
//   api — the pre-existing path: the Messages API on ANTHROPIC_API_KEY, the
//     production-shaped measurement. Opt in explicitly.
const modelFlag = model ? ` --model ${model}` : ''
const evalCommand = backend === 'agent-sdk'
  ? `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npm run eval -- --backend agent-sdk --judge-backend agent-sdk --concurrency ${concurrency}${modelFlag}`
  : `npm run eval -- --backend api --concurrency ${concurrency}${modelFlag}`
const credentialNote = backend === 'agent-sdk'
  ? `This spends a Claude subscription, not an API key. The eval runner reads CLAUDE_CODE_OAUTH_TOKEN ` +
    `from the primary checkout's .env.local on its own (a worktree has none and must not get one): ` +
    `do not export, print, cat, copy or echo that token or any .env file, and do not create a ` +
    `.env.local anywhere. If the run says the token is missing, report that in anomalies and stop.`
  : `This bills ANTHROPIC_API_KEY (the api backend was requested explicitly). Never print or copy the key.`

const DIMS_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: { pass: { type: 'number' }, fail: { type: 'number' }, other: { type: 'number' } },
    required: ['pass', 'fail'],
  },
}
// What every scored run reports back, baseline and variant alike. `usage` is
// the result file's aggregate, so the orchestrator can state token spend;
// `erroredCases` is the count of cases whose result carries `error` (a rate
// limit, a not-logged-in SDK, a crash) — a run with any is not a measurement
// and is never compared.
const RUN_PROPERTIES = {
  dims: DIMS_SCHEMA,
  erroredCases: { type: 'number' },
  resultFile: { type: 'string' },
  promptVersion: { type: 'string' },
  usage: {
    type: 'object',
    properties: {
      inputTokens: { type: 'number' },
      outputTokens: { type: 'number' },
      costUsd: { type: 'number' },
    },
  },
  anomalies: { type: 'string' },
}
const BASELINE_SCHEMA = {
  type: 'object',
  required: ['dims', 'erroredCases', 'failures'],
  properties: {
    ...RUN_PROPERTIES,
    failures: { type: 'array', items: { type: 'string' } },
  },
}
const VARIANT_SCHEMA = {
  type: 'object',
  required: ['dims', 'erroredCases', 'editSummary', 'diff'],
  properties: {
    ...RUN_PROPERTIES,
    editSummary: { type: 'string' },
    diff: { type: 'string' },
  },
}

// These two also live in evals/src/compare.ts, where evals/gate.ts and the
// tests can reach them. They stay INLINE here because a workflow script is
// plain JS evaluated as a function body — no module resolution, no filesystem,
// and no TypeScript loader — so `import` is not available at all.
// evals/__tests__/compare.test.ts lifts the two definitions below out of this
// file and pins them to compare.ts's behavior, so the copies cannot drift.
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
  `Then run exactly this command from the checkout root and let it finish (it takes many minutes; ` +
  `wait, do not re-run it):\n\n    ${evalCommand}\n\n${credentialNote}\n\n` +
  `Read the NEWEST evals/results/*.json it wrote (the path is printed on its last line). Report ` +
  `dims as that file's aggregate.passRateByDimension, verbatim; erroredCases as the number of ` +
  `entries in cases[] that have an "error" field; resultFile as its path; promptVersion as its ` +
  `promptVersion; usage from aggregate.totalInputTokens, aggregate.totalOutputTokens and ` +
  `aggregate.totalCostUsd. If the command itself fails (missing token, rate or usage limit, ` +
  `network, a crash) say so in anomalies, report dims as {} and erroredCases as -1.`

const measured = r => r && Object.keys(r.dims).length > 0 && r.erroredCases === 0
const fmtDims = dims => Object.entries(dims).map(([d, v]) => `${d} ${v.pass}/${v.pass + v.fail}`).join(', ')
const fmtUsage = u => (u ? ` (${u.inputTokens ?? '?'} in / ${u.outputTokens ?? '?'} out tokens)` : '')

phase('Baseline')
log(`backend ${backend}, concurrency ${concurrency}${model ? `, model ${model}` : ''}; ${generations} generation(s) × ${nVariants} variant(s)`)
const baseline = await agent(
  `You are the baseline scorer for an evolutionary search over the Apex coach prompt.\n` +
    (lane
      ? `Lane: ${lane}\nWork in that worktree: \`cd ${lane}\` first; every command below runs there, never in the primary checkout.\n`
      : `Lane: none — scores the committed prompt where the orchestrating session already runs; it edits nothing.\n`) +
    `Read evals/README.md first. Do not edit anything. ${scoreInstructions} ` +
    `Also list each failing case as "caseId (dimension): one-line reason" in failures.`,
  { label: 'baseline', schema: BASELINE_SCHEMA },
)
if (!measured(baseline)) {
  const why = baseline?.erroredCases > 0 ? `${baseline.erroredCases} case(s) errored` : 'the run did not complete'
  return { error: `Baseline eval run is not a measurement (${why}) — nothing to climb. ${baseline?.anomalies ?? ''}`, backend }
}
log(`baseline: ${fmtDims(baseline.dims)}${fmtUsage(baseline.usage)}`)

// The variation-operator angles, one per variant index. Prompt-varied
// diversity: each operator attacks the failures a different way.
const ANGLES = [
  'Target the single worst dimension: read its failing transcripts under evals/results/transcripts/ and fix the specific instruction the coach ignored or misread.',
  'Tighten wording: find the prompt section the failures implicate and make its rule impossible to misread — shorter and sharper, not longer.',
  'Restructure: move or regroup the implicated guidance so the rule and its exception sit together; change meaning nowhere.',
  'Add one worked example to the section the failures implicate, in the exact shape the eval cases exercise.',
]

let champion = { dims: baseline.dims, diff: null, editSummary: 'baseline (unmodified prompt)' }
const lineage = [{
  gen: 0, variant: 'baseline', dims: baseline.dims, editSummary: champion.editSummary,
  promptVersion: baseline.promptVersion, usage: baseline.usage,
}]

for (let gen = 1; gen <= generations; gen++) {
  const results = await parallel(
    Array.from({ length: nVariants }, (_, i) => () =>
      agent(
        `You are ONE variation operator in a bounded evolutionary search over the Apex coach ` +
          `prompt (AVO-style: you decide what to inspect, change and test; the harness scores you).\n` +
          `Lane: none — the harness cut an isolated worktree for this variant (isolation: "worktree"); your cwd is it.\n` +
          `Run \`npm ci --no-audit --no-fund\` there first (node_modules is per-worktree).\n\n` +
          `Angle for this variant: ${ANGLES[i % ANGLES.length]}\n\n` +
          `Current champion prompt state:${champion.diff ? `\napply this diff to src/lib/coach/prompt.ts before your own edit:\n${champion.diff}` : ' the committed prompt, unmodified.'}\n\n` +
          `Champion per-dimension results: ${JSON.stringify(champion.dims)}\n` +
          `Baseline failures:\n${baseline.failures.map(f => `- ${f}`).join('\n')}\n` +
          `Lineage so far (do not repeat a failed edit): ${JSON.stringify(lineage.map(l => ({ gen: l.gen, edit: l.editSummary, dims: l.dims })))}\n\n` +
          `Read evals/README.md, then make ONE targeted edit to src/lib/coach/prompt.ts and ` +
          `NOTHING else — schemas.ts, tools.ts and model.ts are off limits (the results file ` +
          `hashes the behavior surface, so any other edit is visible). Respect the data ` +
          `conventions already encoded in prompt.ts (one movement per entry, per-side reps for ` +
          `unilateral work). Bump PROMPT_VERSION at the top of prompt.ts in the same edit ` +
          `(same date-dot-serial format, next serial) so the results file names the variant it scored. ` +
          `${scoreInstructions}\n\n` +
          `Report diff as \`git diff src/lib/coach/prompt.ts\` INCLUDING the champion diff you ` +
          `applied (the full delta from the committed file), and editSummary as one sentence. ` +
          `Do not commit, push, or open a PR.`,
        { label: `g${gen}v${i}`, phase: 'Evolve', isolation: 'worktree', schema: VARIANT_SCHEMA },
      ),
    ),
  )

  const scored = results.filter(Boolean)
  for (const v of results) {
    if (!v) log(`generation ${gen}: a variant agent returned nothing (skipped or died) — not scored`)
    else if (!measured(v)) log(`generation ${gen}: "${v.editSummary}" is not a measurement (${v.erroredCases === -1 ? 'run failed' : `${v.erroredCases} case(s) errored`}) — not compared. ${v.anomalies ?? ''}`)
  }
  const winners = scored.filter(v => measured(v) && dominates(v.dims, champion.dims))
  for (const v of scored) {
    lineage.push({
      gen, variant: v.editSummary, dims: v.dims, editSummary: v.editSummary, kept: winners.includes(v),
      measured: measured(v), erroredCases: v.erroredCases, promptVersion: v.promptVersion, usage: v.usage,
      diff: v.diff,
    })
    log(`generation ${gen}: ${v.editSummary} — ${fmtDims(v.dims)}${fmtUsage(v.usage)}${winners.includes(v) ? ' — dominates' : ''}`)
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
  backend,
  champion: champion.diff ? champion : { note: 'no variant beat the committed prompt; nothing to apply', dims: champion.dims },
  lineage,
}
