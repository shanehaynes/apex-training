# W12 — Live Activity + Dynamic Island for the tracker

**Machine:** Mac · **Depends on:** W4 · **Unblocks:** —
**Status:** blocked on W4

## Goal
Start a workout and see the elapsed timer (and the title, where it fits) in the Dynamic Island
and on the Lock Screen (D-016).

## Scope
In:
- `ApexWidgets` extension target in `project.yml` (ActivityKit; `NSSupportsLiveActivities`).
- `TrackerActivityAttributes { title }`, `ContentState { startedAt, exerciseCount?, phase }`;
  timer via `Text(timerInterval:)` so no periodic pushes; final state "Done · 42:10" for a
  few minutes after finish; end on cancel.
- Start on tracker open (only if a session is `started`), update on finish/cancel, re-attach
  on relaunch if a session is still open.
- Layouts: compact (timer), minimal (glyph), expanded (title + timer + "Open"), Lock Screen
  banner; house colours (the extension links `ApexUI` tokens).
- Tapping opens the tracker via `apextraining://app/tracker/<eventId>/<date>`.
Out: rest timer (Backlog) — leave a hook in `ContentState` for it.

## Acceptance
- Device: start → island shows timer; background 30 min → still correct; finish → final
  state; cancel → dismissed; relaunch mid-session → reattached.
- Snapshot of the expanded layout with a long title (truncation rule documented).

## Session log
- (none yet)
