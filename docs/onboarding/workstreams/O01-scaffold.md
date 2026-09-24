# O01 — Scaffold

**Wave:** 0 · **Depends on:** — · **Unblocks:** every other lane
**Status:** in review (`chore/onboarding-scaffold`) · orchestrator

## Goal
Pre-create every file two lanes would otherwise both want to touch, so waves 1 and 2 stay
disjoint: the docs board, the tip catalog with all 25 ids and draft copy, the help page
stubs, the per-page CSS files pre-imported, the empty image and shots directories.

## Scope
In: `docs/onboarding/**`, `src/lib/onboarding/tips/*` (+ `catalog.test.ts`),
`src/lib/help/pages.ts`, `help/*`, `public/help/<slug>/.gitkeep`, `src/styles/tips.css`,
`src/styles/help.css`, `src/styles/help/*.css`, the three imports in `src/App.tsx`,
`e2e/shots/.gitkeep`, a pointer in `CLAUDE.md`.
Out: any behaviour. Nothing here renders yet.

## Acceptance
- `npm run agent:check` green; `catalog.test.ts` proves ids unique, bodies ≤ 35 words,
  titles ≤ 5, help slugs resolve.
- Every wave-1 and wave-2 brief names files that exist on `main`.

## Session log
- 2026-09-24 · Linux · created from the approved plan; see STATUS.md.
