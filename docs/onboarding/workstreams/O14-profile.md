# O14 — Profile tips + `calendar-feed` page

**Wave:** 2 · **Depends on:** O03, O04 · **Unblocks:** O16 external shots
**Status:** ready · branch `feat/help-profile` · port 5228 · lock slot e2e_slot_3

## Tips (`src/lib/onboarding/tips/profile.ts`)
| id | trigger | condition |
|---|---|---|
| coach-goal | `ProfileView` | a key save just succeeded (`hasKey` false → true) and `coach_goal` is empty |
| calendar-feed | the Calendar feed `ProfileDisclosure` | first open |
| connector-first | the AI connector `ProfileDisclosure` (`McpTokens`) | first open; the tip points at the existing guide button, no new page |

## Help page `help/calendar-feed.md`
Problem: "I live in Apple / Google Calendar." Shots: 01 Profile → Calendar feed with the
URL and copy button (mock); external placeholders 02 iOS Calendar → Add Subscription
Calendar (375, redact the URL), 03 Google Calendar → Other calendars → From URL (1280),
04 a phone calendar showing an Apex workout (375, redact other events). Note: read-only,
updates take a few hours, anyone with the link can read it.

## Ownership
`src/components/profile/*` except `ConnectorGuide*.tsx` and `CorosConnection.tsx` (O15),
`src/lib/onboarding/tips/profile.ts`, `help/calendar-feed.md`, `public/help/calendar-feed/`,
`e2e/shots/calendar-feed.shots.ts`, `src/styles/help/calendar-feed.css`,
`e2e/mock/tips-profile.spec.ts`, this file. The **Help** row itself is O04's.

## Session log
