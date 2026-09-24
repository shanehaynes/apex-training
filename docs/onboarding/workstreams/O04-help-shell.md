# O04 — Help shell

**Wave:** 1 · **Depends on:** O01 · **Unblocks:** every help page (O08, O09, O10, O14, O15)
**Status:** ready · branch `feat/help-pages` · port 5213

## Goal
`/help` and `/help/<slug>` render `help/<slug>.md` with images, signed out or in, and a
lane can regenerate a page's screenshots with one command.

## Scope
In:
- `src/lib/legal/markdown.ts` — `Block` gains `{ type: 'image'; alt; src }` for a line
  `![alt](/help/...png)`; `legalMarkdownViolations` unchanged (legal stays image-free);
  new `helpMarkdownViolations(source, slug)` requiring
  `^/help/<slug>/\d{2}-[a-z0-9-]+\.(phone|desktop)\.png$`. Tests alongside the existing ones.
- `src/components/legal/MarkdownBlocks.tsx` — `renderBlock`/`renderInlines` extracted from
  `LegalPage.tsx`, plus the image case (`<figure className="help__figure"><img loading="lazy" alt>
  <figcaption>`). `LegalPage.tsx` consumes it unchanged in behaviour.
- `src/lib/help/pages.ts` — add the `?raw` sources (keep the data shape; O01 created it).
- `src/components/help/HelpPage.tsx`, `HelpIndex.tsx` — chrome "← Apex", "All help";
  index lists `HELP_PAGES` with summaries.
- `src/App.tsx` — match `/help` and `/help/<slug>` above `AuthProvider`, like the legal pages.
- `src/styles/help.css` — page chrome, figure, list markers (Tailwind preflight strips them;
  see `app.css` ~6749 for the legal fix).
- `src/components/profile/ProfileView.tsx` — one **Help** row linking `/help` (new tab).
- `playwright.config.ts` — projects `shots-phone` (375×812) and `shots-desktop` (1280×950),
  `testDir: 'e2e/shots'`, `deviceScaleFactor: 2`, same `fakeNow` and webServer as `mock`.
- `e2e/lib/helpShots.ts` — `helpShot(page, { slug, n, name, highlight? })`.
- `e2e/shots/README.md` (or a comment in helpShots) with the run command; one proof spec
  `e2e/shots/_proof.shots.ts` that shoots the calendar into the scratch dir, not `public/`.
- `src/lib/help/__tests__/documents.test.ts` — per page: file exists, title matches,
  `helpMarkdownViolations` empty, every referenced PNG exists unless an `EXTERNAL:` comment
  sits directly above it, every PNG under `public/help/<slug>/` is referenced.
- `e2e/mock/help.spec.ts` — signed-out `/help` and `/help/get-api-key` render; a stub image
  loads; phone viewport has no horizontal scroll.
Out: page content (wave 2), external screenshots (O16), `vercel.json` (not needed).

## Acceptance
- `npm run agent:check` green; `npx playwright test --project=shots-phone --project=shots-desktop
  e2e/shots/_proof.shots.ts` writes two PNGs.
- The legal pages are pixel-identical (compare a `shot` before/after).

## Session log
