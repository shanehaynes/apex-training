# UX improvements over the mobile web

The brief: functionality identical, aesthetics matching, and a large aggregate of small and
medium improvements. This is the checklist. Each row names the web evidence (so a session can
see what "worse" looks like today) and the workstream that owns the fix. Tick rows in the
workstream's session log, not here — this file is the inventory.

| # | Improvement | Web today (evidence) | Owner |
|---|---|---|---|
| U1 | Every tap target ≥ 44pt | `.tracker-set__remove` 24px, `.event-chip__check` 22px, `.composer-difficulty__dot` 14px, `.tile-card__menu-btn` 26px (`src/styles/app.css`) | all UI workstreams; audited in W13 |
| U2 | Native numeric keyboards with an input-accessory bar (Next / Done) and set-to-set focus advance | `type="text"` + `inputMode` everywhere, no `enterKeyHint`, no focus advance (`TrackerExercise.tsx`) | W4 |
| U3 | Keyboard-avoiding tracker confirm bar and chat composer | `.tracker-confirm` is `position: fixed` and is covered by the keyboard; the coach input needed a regression spec (`e2e/mock/mobile-chat.spec.ts`) | W4, W6 |
| U4 | No zoom-on-focus, ever | only `.chat-input` and `.auth-input` are 16px; everything else 12–14px zooms iOS Safari | inherent to native |
| U5 | Sheets with detents, grab handle and drag-to-dismiss for event and day detail | modal scales in (`scale 0.94 → 1`) even when CSS turns it into a bottom sheet; no handle (`app.css:1659`) | W2 |
| U6 | Swipe between days and months; long-press a day to add | chevron taps only; no gestures | W2 |
| U7 | Completion toggle reachable from every view | month/week check circles are `opacity: 0` until `:hover` (`app.css:339,566`) — impossible on touch. iOS: Day cards carry a 44pt control; a month chip opens the day sheet, whose rows carry the same control (D-023 note) | W2 |
| U8 | Toasts render above the tab bar | `.toasts { bottom: 20px }` sits under the 60px mobile nav | W1 (toast component) |
| U9 | Native date / time / select pickers in dark | `type="date"`/`type="time"`/`<select>` render light-mode controls; only `.modal-meta-input` sets `color-scheme: dark` | W7, W10, W11 |
| U10 | Reorder exercises with a real drag handle (`List.onMove`) | framer-motion `Reorder` from an 18px grip with `touch-action: none` (`EventExerciseEditor.tsx`) | W7 |
| U11 | Library rows show "last performed" and "in N workouts" on phone | `.library-row__stats` hidden at ≤768px (`app.css:3439`) | W10 |
| U12 | Block by-week attainment visible on phone | `.block-weeks__attainment` hidden at ≤768px (`app.css:5935`) | W10 |
| U13 | Chart values on tap/scrub, not hover; tile menus and dimmed-chip reasons visible without hover | recharts hover tooltips; `title=` attributes carry the only explanation (`TileBuilder.tsx`) | W9 |
| U14 | Stream charts (HR / elevation / route) scrub with a drag gesture | `onPointerMove` crosshair (`StreamCharts.tsx:93`) | W2 (event detail) |
| U15 | Keep the screen awake during a tracked workout | none | W4 |
| U16 | Haptics: set logged, PR hit, workout completed, action confirmed | none | W4, W6, W13 |
| U17 | Pull-to-refresh and a "cached · updated 3h ago" affordance | none; failed reads toast | W2 |
| U18 | Log a whole workout offline; sets replay when back online | writes fail offline | W4 |
| U19 | Share sheet / copy for the ICS URL and MCP tokens; `webcal://` subscribe button | `navigator.clipboard.writeText` only | W11 |
| U20 | Password AutoFill + Face ID via associated domains | real `<form>`s help Keychain, but no app association | W1 (AASA), W2 |
| U21 | Dynamic Type across the app; tabular numerals for all numbers | fixed px sizes (9–13px micro text) | W13 audit |
| U22 | Multiline composer with an explicit Send; no Enter/Shift-Enter idiom | Enter sends, Shift-Enter newlines (desktop idiom) | W6 |
| U23 | Universal links open invite and recovery emails in the app | links land on the web Site URL | W2 |
| U24 | Settings as grouped native sections (You tab) | one long profile page | W11 |
| U25 | Elapsed-timer Live Activity in the Dynamic Island with the workout title | none | W12 |
| U26 | Analytics tiles legible on a phone: readable tick text, KPI rows that wrap on purpose, table tiles with sticky headers, editable order and size | fixed 260px stack, 10px ticks, no editing (`AnalyticsView.tsx:154`) | W9 |
| U27 | Tracker header never truncates the title mid-word; date and timer on their own line | "Morning Moveme…" at 390px (regenerate `e2e/screenshots/tracker-mobile.png` with `npm run e2e`) | W4 |
| U28 | Shadow-fill of last session's values stays, with a clearer "ghost" treatment and a one-tap "use last" per exercise | commits the whole row on first focus, then `select()` (`TrackerExercise.tsx:322`) — keep, improve affordance | W4 |
| U29 | Duration entry keeps the "microwave" digit buffer but without the blur/refocus keyboard-swap hack | `DurationInput.tsx:70` re-focuses to change the iOS keyboard | W4 |
| U30 | Sync confirmations as a bottom sheet queue, not a top-right popover | `position: fixed; top: 64px; right: 16px` (`ProviderSyncControls.tsx`) | W11 |
| U31 | Coach model badge and key status in the composer header; 402 opens the key screen in one tap | inline CTA opens the whole profile | W6 |
| U32 | Onboarding as a native paged flow with the setup nudge as a dismissible card on the Schedule tab | 6-step tour + nudge above the nav (`OnboardingHost.tsx`) | W13 |

Backlog (not in this roadmap): rest timer between sets, push notifications, HealthKit write,
Apple Watch, home-screen widget for today's workout.
