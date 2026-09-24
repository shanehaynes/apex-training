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
