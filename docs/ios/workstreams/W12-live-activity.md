# W12 — Live Activity + Dynamic Island for the tracker

**Machine:** Mac · **Depends on:** W4 · **Unblocks:** —
**Status:** in progress — PR A (`feat/w12-activity-target`) open; PR B next

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
- 2026-09-09 · Mac · Plan and PR A. Landing as two PRs from one worktree: **A** the
  `ApexActivity` package target (attributes, content state, the island and Lock Screen views),
  the `ApexWidgets` extension target, `NSSupportsLiveActivities`, snapshots — no behaviour
  change; **B** the `TrackerActivityPublishing` seam and `TrackerModel` hooks, `DeepLink.tracker`
  + the first `pendingRoute` consumer, relaunch adopt, 0.5.0, docs. Plan of record:
  `~/.claude/plans/w12-live-activity.md` on Shane's Mac.
  - **Found on the way in:** `AppModel.pendingRoute` is parked and never consumed, and
    `RootTabView` has no selection binding — tap-to-open needs the first route consumer (B).
    The custom scheme has no `app` host, so the brief's URL parses to nil today (B). App Store
    Connect rejects an extension whose version differs from the app's, so `MARKETING_VERSION`
    and `CURRENT_PROJECT_VERSION` moved to project-level settings in `project.yml`.
  - **Decisions taken (to record in decisions.md with B):** attributes carry `eventId` and
    `eventDate` with the title (the tap URL needs them; a relaunch reconciles on them);
    `ContentState.restEndsAt` reserved for the rest timer; views and attributes live in one
    SwiftPM target linked by app and extension (ActivityKit pairs by type), depending on
    `ApexUI` + `ApexCore` only (extension memory ceiling); compact/minimal use the system font.
  - **Truncation rule:** compact and minimal show no title; expanded centre one line, tail;
    Lock Screen banner two lines, tail (U27's rule). Snapshots in `__Snapshots__/ActivitySnapshotTests`
    are all in the `.done` phase — a running `Text(timerInterval:)` is never snapshot-stable.
  - **Proved:** simulator build embeds `ApexWidgets.appex` with the ApexUI font bundle and no
    GRDB/supabase; 94 unit + 8 UI tests green; `testflight.sh --dry-run` archived and exported
    an IPA with the extension signed under the team (bundle id minted by automatic signing).
    Open: the extension's own `ApexFonts.register()` is exercised only when an activity runs (B).
