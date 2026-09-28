# D02 · The notebook: memory, proposals, the contract, the doctrine — one page the athlete owns

## Goal
A full-screen page (phone-first) where the athlete sees and controls everything the coach
carries between conversations:

- **Memory** — confirmed facts by kind (injury · goal · preference · history · note), pending
  proposals with Accept / Forget, an add-a-fact form. Over `/api/coach-memory` (on `main`).
- **Contract** — the coaching contract text (`profiles.coach_contract`, lane D01), editable and
  saved; pending contract-edit proposals as before/after diff cards with Accept / Reject (over
  `/api/coach-reflections`, lane D01). When the column or the handler is not there yet the tab
  says "not available yet" — it never errors.
- **Doctrine** — the coach's method, read-only: `DOCTRINE_TOPICS` from
  `src/lib/coach/doctrine/index.ts`, one expandable section per topic.

Why: decision D-C02 makes every self-improvement a proposal the athlete approves. Proposals
need a place to be approved, and the athlete deserves to see what the coach holds about them.

## Context you need (all on `main`)
- **Overlay pattern:** `src/components/analytics/AnalyticsView.tsx` is mounted by
  `src/components/layout/AppShell.tsx` (`{state.analyticsOpen && <AnalyticsView />}`, lines
  58–60) and opened by the calendar reducer (`src/context/calendar.ts`: state flags, the
  `OPEN_ANALYTICS` / `CLOSE_ANALYTICS` actions at the end of the action union, the reducer
  cases). `ProfileView.tsx` is the other overlay; its AI › Coach section (around line 336) is
  where your entry button goes ("Open the notebook"). `AppShell` uses `isMobile =
  useMediaQuery('(max-width: 768px)')`; design for that width first.
- **Memory API:** `api/_lib/handlers/coachMemory.ts` — GET `{ memories: [{id, kind, content,
  confidence, source_kind, created_at, confirmed_at, confirmed}] }` (non-archived, newest first);
  POST `{id}` confirms a proposal (409 when the 200-fact cap is full — show the message); POST
  `{kind, content}` adds a fact; DELETE `{id}` archives. Client helpers already in
  `src/lib/api.ts` (`listCoachMemory`, `confirmCoachMemory`, `addCoachMemory`,
  `archiveCoachMemory`) and types in `src/lib/coach/memory.ts` (`CoachMemory`, `MEMORY_KINDS`,
  `MEMORY_KIND_ORDER`, `memoryFileLabel`).
- **Contract + reflections (D01, in flight — interface contract, code against it):**
  `GET /api/profile` gains `coachContract: string | null` and `reflectionOptIn: boolean`;
  `PATCH /api/profile { coach_contract }` (≤ 2000 chars, '' clears) and `{ reflection_opt_in }`;
  a missing column answers 409 `column-missing` (the `tips_seen` precedent in
  `api/_lib/handlers/profile.ts`). `GET /api/coach-reflections` → `{ reflections: [{ id, day,
  status, contract_before, contract_after, reason, memory_proposal_ids, created_at,
  resolved_at, resolution }] }`; `POST /api/coach-reflections { id, resolution: 'accepted' |
  'rejected' }`. Until D01 merges these return 404 — treat 404 and 409 as "not available yet".
  Add the client helpers to `src/lib/api.ts` (see Ownership for the anchor) and the client types
  to a new pure file `src/lib/coach/notebook.ts`.
- **Doctrine:** `src/lib/coach/doctrine/index.ts` — `DOCTRINE_TOPICS` (id, title), `readDoctrine(id)`
  returns the topic text (plain text with headings; render it with the same light markdown the
  chat sidebar uses, or as preformatted paragraphs — no new dependency).
- **Styling:** `src/styles/app.css` is off limits. New CSS in `src/components/notebook/notebook.css`;
  tokens from `src/styles/tokens.css`; `src/components/calendar/annotations.css` and
  `src/components/sidebar/chat-reads.css` are recent small examples.
- **Mock e2e:** `e2e/mock/coach-annotations.spec.ts` shows how a spec seeds a table in the mock
  backend and drives a phone viewport. Add one that opens the notebook from the profile, sees a
  seeded pending memory proposal, accepts it, and sees it move to the confirmed list.

## Ownership
- New: `src/components/notebook/**` (`NotebookView.tsx`, `MemoryTab.tsx`, `ContractTab.tsx`,
  `DoctrineTab.tsx`, `notebook.css`), `src/lib/coach/notebook.ts` (pure types/helpers), tests,
  one mock e2e spec.
- Append-only at a named anchor (lane D03 appends to the same files at different anchors —
  touch nothing else in them):
  - `src/context/calendar.ts`: state flag `notebookOpen` directly after `analyticsOpen` (in the
    state type and the initial state), actions `OPEN_NOTEBOOK` / `CLOSE_NOTEBOOK` directly after
    `CLOSE_ANALYTICS` in the union, reducer cases directly after the analytics cases.
  - `src/components/layout/AppShell.tsx`: one line `{state.notebookOpen && <NotebookView />}`
    directly after the `profileOpen` line, import next to `ProfileView`'s.
  - `src/lib/api.ts`: your helpers at the very end of the file under a
    `// ── Coach notebook …` header.
  - `src/components/profile/ProfileView.tsx`: the entry button inside the AI › Coach section.
- Not yours: `api/**` (D01 owns the handlers you call), `src/lib/coach/{prompt,schemas,tools}.ts`,
  `api/chat.ts`, `src/hooks/useChat.ts`, `src/components/calendar/**`, `src/components/review/**`
  (D03), migrations, `database.types.ts`, doctrine text, evals.

## Steps
1. Reducer + AppShell + ProfileView entry; an empty `NotebookView` with three tabs; phone layout.
2. Memory tab over the existing helpers: confirmed by kind (newest first), proposals section on
   top when any are pending (Accept → `confirmCoachMemory`, Forget → `archiveCoachMemory`,
   optimistic, errors toast via the helpers' own `notify`), add-a-fact form (kind select +
   text ≤ 500). Empty state copy in the coach's voice.
3. Contract tab: textarea with a character count, Save (PATCH), the two-state banner for
   "not available yet"; reflections list as diff cards (before/after line diff is fine as two
   blocks with the changed lines highlighted — no diff dependency), Accept / Reject.
   Reflection opt-in toggle lives here too (`reflection_opt_in`).
4. Doctrine tab: topic list → expanded text.
5. Tests: reducer actions; tab rendering with stubbed `api.ts` helpers (pending → accept →
   confirmed; 404/409 → banner); the pure helpers. Mock e2e as above.
6. Report.

## NOT VERIFIED to carry forward
The contract and reflections endpoints (D01, merges first); mock e2e in your container if
Playwright cannot launch (CI's `e2e-mock` covers it).
