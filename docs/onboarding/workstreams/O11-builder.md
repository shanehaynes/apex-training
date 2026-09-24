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
