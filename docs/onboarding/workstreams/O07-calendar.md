# O07 — Calendar + day view tips

**Wave:** 2 · **Depends on:** O03 · **Unblocks:** —
**Status:** ready · branch `feat/help-calendar` · port 5221 · lock slot e2e_slot_2

## Tips (`src/lib/onboarding/tips/calendar.ts`)
| id | trigger | condition |
|---|---|---|
| day-complete-circle | `DayView` (phone) / `EventChip` (desktop) | first render with ≥ 1 event on the shown day |
| template-copied | next calendar mount after `useTemplateCopy` succeeds | `template_copied_at` null → set this session |

## Ownership
`src/components/calendar/*`, `src/components/modal/DayModal.tsx`, `src/hooks/useTemplateCopy.ts`,
`src/lib/onboarding/tips/calendar.ts`, `e2e/mock/tips-calendar.spec.ts`, this file.
No help page. No shots.

## Acceptance
Fresh profile with `tips: 'on'`: the tour dismissed, the day view shows
`day-complete-circle` once; after Copy the starter plan, `template-copied` on the next load;
neither returns after Got it. Existing calendar specs unchanged.

## Session log
- 2026-09-24 — Copy refined in `tips/calendar.ts` (day-complete-circle "Mark a workout done",
  23 words; template-copied "Your plan is in", 26 words, bold on-screen labels **Delete
  workout** / **This day only** / **Whole series**). `day-complete-circle` is offered from
  `DayView` (phone, ≥ 1 event on the shown day) and once per grid from `MonthView` / `WeekView`
  (desktop, ≥ 1 event with a complete circle in view) rather than from every `EventChip`.
  `template-copied`: `useTemplateCopy` leaves a per-user `apex:template-copied-here:<id>`
  marker in localStorage on a fresh copy; `Calendar` reads it once per mount and offers the
  tip while `template_copied_at` is set, then clears the marker once the tip is seen. The
  calendar stays mounted under the welcome flow, so the tip lands on the next load.
  Spec: `e2e/mock/tips-calendar.spec.ts`.
