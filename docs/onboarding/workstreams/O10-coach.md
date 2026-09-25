# O10 — Coach tips + `get-api-key` page

**Wave:** 2 · **Depends on:** O03, O04, O06 (for the subscriber section's wording) · **Unblocks:** O16 external shots
**Status:** ready · branch `feat/help-coach` · port 5224 · lock slot e2e_slot_2

## Tips (`src/lib/onboarding/tips/coach.ts`)
| id | trigger | condition |
|---|---|---|
| coach-first-message | `ChatSidebar` | key present, no messages in the thread (phone: the Coach tab opened) |
| coach-confirm-card | `ConfirmCard` | first render of a pending action |

`builder-coach` lives in O11 (its trigger is in `builder/`); `coach-goal` in O14 (`ProfileView`).

## Help page `help/get-api-key.md`
The hardest page and the one that matters most. Sections: what a key is (a code that lets
Apex use Claude on your account; you pay Anthropic per use, usually cents a day); the steps
with external placeholders — 01 console sign-up (375), 02 billing / buy credits (1280,
redact), 03 API keys page empty with **Create Key** (1280), 04 the create-key dialog with
**Workspace** set to a named workspace, not "same as personal account" (1280 — load-bearing:
an unscoped key 400s, see `ProfileView.tsx` ~375), 05 the one-time reveal (redact all but
`sk-ant-`); then mock shots 06 Profile → Anthropic API key disclosure empty (`page.route`
the key status to `hasKey:false`) and 07 key saved. **Already pay for Claude?** — a
claude.ai plan does not include API use; the key is a separate pay-as-you-go account at
console.anthropic.com, same email is fine; what it costs in plain words; the model picker in
the Coach header changes the price; the honest status from O06's report. Troubleshooting:
key not tied to a workspace, expired key, out of credits (the coach's 402/429 states).

## Ownership
`src/components/sidebar/*`, `src/components/coach/*`, `src/lib/onboarding/tips/coach.ts`,
`help/get-api-key.md`, `public/help/get-api-key/`, `e2e/shots/get-api-key.shots.ts`,
`src/styles/help/get-api-key.css`, `e2e/mock/tips-coach.spec.ts`, this file.

## Session log
- **2026-09-24 · feat/help-coach.** Tips wired in `ChatSidebar.tsx`: `coach-first-message`
  conditioned on key saved + empty thread + pane on screen (a ResizeObserver, since AppShell
  keeps the pane mounted and CSS hides it ≤ 1024px unless the phone's Coach tab is open);
  `coach-confirm-card` in `ConfirmCard`, conditioned on the same on-screen flag. Nothing
  autofocuses the chat input, so the typing hold never stalls the first tip; the confirm tip
  lands after a send too (the input is disabled while the turn runs, which drops its focus —
  proven in `tips-coach.spec.ts`). The no-key empty state gains a **How to get a key** link to
  `/help/get-api-key` and stacks as a column (inline style; `.chat-empty` is a row).
  `help/get-api-key.md` written: steps 1–5 are EXTERNAL placeholders, 6–7 are mock shots
  (both viewports) from `e2e/shots/get-api-key.shots.ts`. Troubleshooting quotes the real
  strings: the workspace 400 and rejected-key messages from `api/_lib/anthropicKey.ts`, and
  the coach's 402/429/generic replies from `useChat.ts` — out of credits and an expired key
  both surface as the generic "Sorry, I ran into an error", not as a 402/429.
- 2026-09-25 · orchestrator. Merged as #331; get-api-key sentence-length fixes and the Profile fold rename in #338; 5 external shots pending (O16d).
