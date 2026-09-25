# O11 — Builder tips

**Wave:** 2 · **Depends on:** O03 · **Unblocks:** —
**Status:** ready · branch `feat/help-builder` · port 5225 · lock slot e2e_slot_3

## Tips (`src/lib/onboarding/tips/builder.ts`)
| id | trigger | condition |
|---|---|---|
| builder-search-first | `WorkoutBuilderView` | `step === 'search'`, not editing an existing event |
| builder-repeat | `RepeatPicker` | first mount in create mode |
| builder-coach | `BuilderCoachPanel` | first mount (the ✨ button pressed); `help` only when the key is missing |

## Ownership
`src/components/builder/*`, `src/lib/onboarding/tips/builder.ts`,
`e2e/mock/tips-builder.spec.ts`, this file. No help page (repeating-workouts is O08's; its
shots drive the builder UI without editing it).

## Session log
- 2026-09-24 — Tips wired and copy refined. `useTip` sites: `WorkoutBuilderView`
  (`builder-search-first`, conditioned on `!editing && step === 'search'`), `RepeatPicker`
  (`builder-repeat`, conditioned on `!lockOff && !repeat.custom`, so it also offers on a
  one-off event being edited — the On/Off switch is on screen there too), `BuilderCoachPanel`
  (`builder-coach`, unconditioned: mounting is the ✨ press). Focus hold: the search box
  autofocused, which held `builder-search-first` for as long as the box kept focus; it now
  autofocuses only when the library has something to search (`templates.size > 0`) — an
  empty library has nothing to find and a phone would raise its keyboard over **Build a new
  workout**. With saved workouts the tip still waits until the user leaves the box.
  `builder-coach` keeps the static `get-api-key` help; the copy ("It uses your own key from
  Anthropic.") reads true with or without a key on file. e2e: `e2e/mock/tips-builder.spec.ts`
  (each test serves a profile with every other tip seen, so a calendar tip from another lane
  can never spend the load's one tip). Found outside this lane: on a 375×812 phone the setup
  nudge covers the **+** menu's items, so **Workout** cannot be tapped until the nudge is
  closed.
- 2026-09-25 · orchestrator. Merged as #332; the setup-nudge bug it found is fixed in #337.
