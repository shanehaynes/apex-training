# iOS UX review — 2026-09-21

A walk through the whole app as a user, on a fresh build of `main` (2b77d19, 0.9.0, built 2026-09-21 11:38) on the
iPhone 17 Pro simulator, iOS 26.5. Two passes: fixtures (`-apexMockClient`, every state
reachable) and the seeded local stack (97 events, 69 exercise definitions — the dense screens).
Evidence is in `ios/build/review/*.png` (git-ignored; regenerate with the steps at the end).
The rubric is in the plan this review came from; the six principles it grades against:

1. **Low clutter via progressive disclosure** — one primary action, one primary read per screen.
2. **Trust the user** — no unasked-for nudges, no confirmation on reversible actions.
3. **Designed, not generated** — one ground, one ink, one signal; hairlines; no Tailwind chroma.
4. **Native first** — a SwiftUI idiom before a custom control.
5. **Type carries hierarchy; colour carries meaning.**
6. **Copy is specific.**

Every finding names a screen, an element and a change, with the principle it serves and an
effort (S = under an hour, M = a session, L = a workstream). Generic observations were cut.

## 1. Verdict

Three changes matter more than everything else below combined:

1. **Get the day's workouts above the fold.** On the Schedule tab the first workout card
   starts 68% of the way down the screen (`02-schedule-day.png`). Above it: wordmark, "+",
   period bar, Day/Month segmented control, the pinned setup card, the week strip, and a
   42pt date numeral — the date stated four times before any content. Collapse the period
   bar into the navigation title, drop the big numeral (the week strip already says 8 and
   Tuesday), and make the setup card a one-line banner that scrolls with the list. That alone
   brings the first card to ~30%.
2. **Replace the Tailwind chroma with the site's triad.** Every non-neutral colour in the app
   is a Tailwind default (`#f97316` orange-500, `#ef4444` red-500, the sky/green/yellow/
   violet/rose/teal-400 chart ramp) sitting on a warm charcoal, plus one navy leak from the
   retired cold palette (the user's chat bubble). The text colour itself is Tailwind
   slate-100, cool on a warm ground. Section 2 has the token table; the change is a handful
   of hex values in three web files plus one Swift file, then `gen-tokens.mjs`.
3. **Pills are the default control; make them the exception.** The builder shows 15 pills
   before the title field; the tile builder ~33 before the preview; the library and template
   search put two rows of filter chips over a single result. Where a value has more than
   four options or is rarely changed, use a `Picker` (menu style) or a pushed list. Where
   the chip row filters a list, hide it until the list is long enough to need filtering.

Then two bugs (section 4) and a Dynamic Type regression worth fixing before the App Store
submission: the elevation chart's area fill paints over the difficulty row, and at
accessibility text sizes the You tab and the setup card truncate their titles.

## 2. Palette

### What reads as generated

| Tell | Where it is in Apex | Evidence |
|---|---|---|
| Tailwind default hues on a custom ground | `textPrimary #f1f5f9` (slate-100), `positive #f97316` (orange-500), `danger #ef4444` / `dangerText #f87171` / `destructive #b91c1c` (red-500/400/700), chart ramp = sky/green/yellow/purple/rose/teal-400, `attainment.met #2eb82e` | `Tokens.swift`, `Palette.swift` |
| A leak from the retired cold palette | user chat bubble `#1e3a5f` / `#2a5080` — the only blue surface in the app | `25-coach-thread.png` |
| Uniform pills as the default control | `Chip`, `ChipRow`, `MultiChipRow`, `TypeChip`, `ApexSegmented`; 8 of 22 components are chip-shaped | `13`, `14`, `23`, `24`, `28` |
| `sparkles` as the AI icon | Coach tab icon, the coach empty state, the builder's coach drawer button, "Use last" in the tracker, the Model row in You | `17`, `09`, `14`, `20` |
| Thin generic line icon on every settings row | `SettingsRow(symbol:)` — 17 rows, 17 icons | `19`, `20` |
| Uppercase tracked eyebrow on every group | `apexEyebrow()` — 6 on the tile builder alone; "6 TILES" and "1 EXERCISE" are counts styled as headings | `18`, `28`, `23` |
| Icon-per-datum metadata rows | the event sheet's 13 icon+value pairs | `06-event-sheet.png` |
| Same 12pt radius on everything | nav buttons, Today, segmented, cards, week-strip cells, chips, fields, month cells | every screenshot |
| Glow shadows | `WorkoutPalette.glow`, radius 10 — defined; check it is only on emphasis (it is: chips and rails use `border`/`fill`) | — |

What is **not** a tell and should stay: Inter + JetBrains Mono + Barlow (three faces with
distinct jobs), the dark-only warm ground, the tab bar (iOS 26's own chrome), the tracker
(section 3.4 — it is the best screen in the app).

### Proposed tokens

Targets the web sources per Shane's decision (one palette, both clients): `src/styles/
tokens.css`, `src/utils/workoutColors.ts`, `src/lib/analytics/palette.ts`, then
`node ios/scripts/gen-tokens.mjs`. `ApexPalette` (Swift-only) values move into `tokens.css`
at the same time — design-spec §1's "promote to a token" rows, finally promoted. Contrast is
WCAG 2 against `bgSurface #161412` (worst case of the three grounds), computed, not eyeballed;
text needs 4.5, marks and borders 3.0.

| Token | Now | Proposed | Contrast now → proposed | Why |
|---|---|---|---|---|
| `--text-primary` | `#f1f5f9` slate-100 | `#ede8df` | 16.8 → 15.1 | warm ink on a warm ground; matches the site and the existing accent |
| `--text-secondary` | `#a09590` | `#b8b3a9` | 6.3 → 8.8 | the site's ink-dim; body copy stops looking disabled |
| `--text-muted` | `#8a7f7c` | `#8f8781` | 4.7 → 5.2 | same role, clears 4.5 with margin at 11pt micro text |
| `--accent-primary` | `#e8e2d9` | keep | 14.3 | already the ink — fills with `bgPrimary` text |
| `--border-subtle` | `#2e2a25` solid | ink at 13% (`#ede8df` @ 0.13) | — | the site's rule: a translucent hairline reads as a line, a solid grey reads as a box |
| positive / "done" | `#f97316` orange-500 | `#e8601c` (the site's signal) | 6.6 → 5.4 | one burnt-orange signal instead of a Tailwind default |
| danger | `#ef4444` | `#d9483b` | 4.9 → 4.3 (marks only) | desaturated toward the ground; still reads as red |
| dangerText | `#f87171` | `#e98a7f` | 6.6 → 7.4 | |
| destructive (fill, white text) | `#b91c1c` | keep | 6.5 on fill | fine |
| userBubble | `#1e3a5f` navy | `bgElevated` + hairline | — | remove the last cold-palette surface; the user's words do not need a colour |
| attainment.met | `#2eb82e` | `#7c9a6d` | 7.0 → 5.9 | a sage that is not Tailwind green-500's cousin |
| chart ramp 1–8 | orange, sky, green, yellow, violet, rose, teal, neutral (all Tailwind-400) | `#e8601c` signal, `#ede8df` ink, `#d4a53a` ochre, `#8fae7d` sage, `#7d9bb8` steel, `#c98a84` rose, `#6fa89b` teal, `#8f8781` dim | all ≥ 5.2 | desaturated, warm-biased; series 1–2 are the signal and the ink, so a one-series chart has no chroma but the one that means something |

Workout-type colours are **left alone on purpose**: they carry meaning (principle 5) and the
calendar is unreadable without them. Two changes only: drop the solid chip fill on the day
card in favour of the type name in the rail colour (the rail already says it — `02`), and
render the month chips as dots (section 3.2). `stretching`'s `#6d5fad` is the one purple in
the app and it is semantic; keep it.

Two things in the code the palette change should carry: `RootTabView` sets
`.tint(ApexColor.accent)` but the text caret on the sign-in screen is system blue
(`01-signin.png` after focus) — the tint is applied inside the tab view, not at the window,
so `SignInView` and `SetPasswordView` are untinted; move `.tint` to `RootView`. And
`MonthView` paints the today bubble `ApexPalette.positive` where design-spec §1 says the
accent; pick one (the spec) so orange means "done" and nothing else.

## 3. Per-screen findings

Format: what the user came to do · what competes with it · the change · principle · effort.

### 3.1 Sign-in and set-password (`01-signin.png`)

- **Came to do:** sign in. **Competes:** "Forgot password?" is body-size text at the same
  visual weight as the button; the invite paragraph says the same thing twice ("invite-only.
  Accounts are created by invitation, not sign-up"). **Change:** footnote-size "Forgot
  password?"; one sentence: "Apex is invite-only." + the link. P6 · S.
- **Caret is system blue** (see section 2). P3 · S.
- Otherwise right: three faces, one primary button, AutoFill wired.

### 3.2 Schedule — Day (`02`, `03`) and Month (`04`)

- **Came to do:** see today's workouts and start one. **Competes:** everything above the first
  card. The date is stated four times (period bar, week strip, 42pt numeral, TODAY pill); the
  wordmark is the navigation title on every load; four time-navigation controls (‹ ›, Today,
  Day/Month, the week strip) sit in a column. **Change:** navigation title = the date ("Tue,
  Sep 8", large title collapsing on scroll); wordmark to the You header or nowhere; ‹ › and
  Today into the toolbar; Day/Month as a toolbar menu or a swipe-down; delete the big numeral
  and the TODAY pill (today is the highlighted strip cell). P1, P4 · M.
- **The setup card is pinned** — it sits between the period bar and the list and does not
  scroll away (`03`: the list scrolls under it). With the chrome it leaves 40% of the screen
  for content, on every launch, until all three items are done — and D-035 makes the close
  session-only, so it returns tomorrow. **Change:** one-line banner ("Finish setting up · 1 of
  3 ›") that scrolls with the list and whose close persists (`onboarding_dismissed` exists;
  use it). P2, P1 · S.
- **Type is shown twice per card:** the 3pt rail and a solid filled chip ("Cardio" in green,
  "Outdoor Climbing" in blue). **Change:** rail + the type name as muted text; no fill. P5 · S.
- **Month cells truncate every chip to "Fixtur…"** (5 characters in a 7-column grid). Text
  chips cannot work at this width. **Change:** type-coloured dots (the week strip already does
  this) and the count; the day sheet carries the names. "+1 more" in orange becomes a fourth
  dot. P5, P1 · S.
- **The month grid does not fit the viewport** — rows 27–30 hide under the tab bar at the
  default size (`04`). **Change:** size rows to fill `(height − chrome) / rowCount`, min
  44pt. P4 · S.
- **35 bordered boxes** make the grid. **Change:** hairline grid or none (the numbers align
  themselves); border only on today. P3 · S.
- Long-press a month cell to add, swipe days and months: work, undiscoverable, fine — they
  are accelerators, not the only path.

### 3.3 Day sheet (`05`) and Event sheet (`06`–`08`)

- **Day sheet duplicates the Day view** with a title and a drag handle plus an X. A sheet
  with a handle does not need an X (P4). Bigger question: a month cell could simply switch
  to Day for that date (D-023 chose the sheet so the completion control is reachable — it is
  reachable on Day too). Leave as is unless the Day header shrinks (3.2), then revisit. P1 · M.
- **Event sheet, metadata:** 13 icon+value pairs in three rows, with distance, elevation and
  heart rate each shown twice — the plan and the synced actual, unlabelled (`06`). **Change:**
  a single two-column block: Planned · Actual, mono numbers, no icons; the "Synced from
  COROS" pill becomes the Actual column's header. P1, P6 · M.
- **Actions before content:** four equal buttons in a 2×2 grid (Start Workout · Mark as
  Complete · Edit exercises · Edit workout) come before the description and the exercise
  list (`08`). Mark as Complete is the filled primary though Start is the intent. **Change:**
  content first; a bottom `safeAreaInset` bar with Start (primary) and a `Menu` (Mark
  complete · Edit exercises · Edit workout · Delete). P1, P4 · M.
- **"40 min" prescription in green** (climbing's colour, meaning nothing here). **Change:**
  `textSecondary` mono. P5 · S.
- **A drag on the heart-rate chart swallows the sheet's scroll and detent change** (the first
  swipe in `07` moved nothing). At the medium detent the chart is most of the visible sheet.
  **Change:** scrub on a long-press-then-drag, or tap-to-pin like the tiles (D-029). P4 · S.
- **Bug** — elevation area fill overpaints the difficulty row; section 4.

### 3.4 Tracker (`09`–`11`)

The best screen: one job, mono numbers, ghost values, a real accessory bar. Three notes:

- "Use last" carries a wand-sparkles icon; "Rest 2 min" is green. **Change:** no icon;
  `textSecondary`. P3, P5 · S.
- Leaving mid-session (back arrow) returns to the schedule with nothing in the app saying a
  workout is running (`11`) — the Live Activity is the only indicator. **Change:** the event
  card's control shows a running timer while a session is open. P1 · M.
- Exercise cards sit in bordered surfaces inside a section with a hairline-and-eyebrow
  divider ("MAIN WORK"). Fine; if borders go hairline everywhere (3.2) this follows.

### 3.5 Builder (`12`–`16`)

- The "+" is a native `Menu` (Add workout · Add meal) — right.
- **Template search:** 8 type chips in 3 rows over one template; the search placeholder
  truncates ("name a new work…"). **Change:** chips only when the list exceeds ~8; shorter
  placeholder ("Search or name a workout"). P1, P6 · S.
- **Form:** TYPE (7 chips) · SPORT (5) · SCORING (3) precede TITLE — 15 pills before the
  user names the thing. Sport only matters for cardio; scoring only for For Time / AMRAP.
  **Change:** Title first; Type as a `Picker` (menu) or a single chip row; Sport appears when
  Type is cardio; Scoring under a disclosure ("More options" with repeat, location, tags,
  difficulty, scoring). P1, P4 · M.
- **An empty new workout shows three "Add exercise" scaffolds** under WARM-UP / MAIN WORK /
  COOL-DOWN. **Change:** one "Add exercise"; sections appear when a second is added or on
  demand. P1 · S.
- **Action bar:** Cancel + Apply + a two-line explanation of what Apply does, plus the X and
  the back chevron. **Change:** Apply alone (the sheet has a handle and an X); the sentence
  becomes the button label: "Add to calendar". P6, P4 · S.

### 3.6 Coach (`17`, `25`, `37`)

- Empty state: sparkles + "Ask anything, or get your daily briefing below." + a Coach's
  Notes button that duplicates the toolbar's book icon. **Change:** no icon; one line; the
  button or the toolbar item, not both. P1, P3 · S.
- User bubble navy (section 2). P3 · S.
- Confirmation card: "Delete: Fixture Push Day · 2026-09-29 (this instance)" — an ISO date
  in prose, and Confirm is the filled primary for a destructive action. **Change:** "Tue, Sep
  29"; keep Confirm primary (the user decides — that is the product) but tint the card's
  eyebrow `dangerText` when the action deletes. P6 · S.
- No-key state (`37`): the composer is present but disabled with its own CTA text, under a
  full-screen CTA. **Change:** hide the composer until a key exists. P1 · S.
- The thread itself is right: assistant text with no bubble, Markdown, a plain composer.

### 3.7 Analytics (`18`, `21`–`24`)

- "6 TILES" eyebrow: a count styled as a heading. Delete. P1 · S.
- "Edit +" share one pill; fine on iOS 26.
- KPI tile: "Sessions" title, "SESSIONS" eyebrow, the value — the label twice. **Change:** the
  tile title is the label; KPI shows value + range. P6 · S.
- A one-point line chart renders as an empty 250pt tile with a 4px arc at the top (`21`,
  Avg heart rate). **Change:** fewer than 2 points → the KPI renderer with "1 session". P1 · S.
- Edit mode (`22`) is native and right. Keep.
- **Tile builder:** ~33 pills (6 chart · 3 range · 4 bucket · ~20 measures in 4 groups)
  before the preview, which sits at the bottom where it is never visible while choosing
  (`23`, `24`). **Change:** measure as a pushed grouped list (search-first, 20 items); chart
  and bucket as segmented or `Picker`; the preview pinned at the top of the sheet at 120pt,
  form scrolls under it. P1, P4 · M.

### 3.8 You (`19`, `20`, `26`–`31`)

- The root is the right shape: grouped sections, values on the trailing edge, one sheet
  (Anthropic key). Three notes on it:
  - 17 rows, 17 thin line icons, one of them `sparkles`. Either the Settings-app treatment
    (filled tinted squares — strong, but colour) or none. Recommend none: the labels are
    specific enough. P3 · S.
  - Avatar circle is navy — the other cold-palette leak. `bgElevated`. P3 · S.
  - The "AI coach" footer sentence explains billing under the section; keep — it is the one
    place the user needs it.
- **Training grouping:** Blocks · Meals · Exercise library · Workout library · Heart-rate
  zones. Three are daily-use, two are set-once. The grouping is the web's page list, not
  frequency. **Change:** Library (Exercises · Workouts) as one row that pushes a two-segment
  screen; HR zones under Integrations next to COROS, whose data it interprets. P1 · S.
- **Blocks list (`26`):** "Aug 31 – Sep 27 · base ·…" truncates its own metadata; the
  objective's date is ISO ("2027-05-01"). **Change:** two lines; formatted dates. P6 · S.
- **Meals (`27`):** clean. Keep.
- **Exercise library (`28`):** two rows of category chips above one result; "1 EXERCISE"
  count-as-heading. **Change:** `.searchable` in the nav bar; chips only above ~12 rows
  (the seeded stack has 69 — see section 5 for how it reads at that size). P1, P4 · S.
- **Exercise detail (`29`):** the name is the nav title and the H1; "in 1 workout" is a stat
  styled as a tag chip beside real tags. **Change:** inline nav title only; the stat joins
  the two KPI cards. P6, P5 · S.
- **COROS (`30`):** two paragraphs of explanation on a settings screen; the toggle is tinted
  orange (positive) where the accent is the app's tint. **Change:** one sentence each;
  toggle in accent. P6, P5 · S.
- **AI connector (`31`):** the create-token form is always expanded above the lists;
  "signed in 2026-09-08". **Change:** "Create token…" as a row that opens the name field;
  formatted date. P1, P6 · S.

### 3.9 Onboarding (`32`–`36`)

- **Eight text-only pages**, each 80% empty (`32`–`35`). The copy is good; the container is
  not. **Change:** four pages (welcome + plan, log, coach, connect) or one scrolling page with
  the three setup actions inline. P2 · M.
- **Copy says "Month, week, or day"** (step 2) and then "On a phone, Apex shows one day at a
  time" (step 8); iOS has no week view (D-009). The catalog is generated from the web's
  `content.ts`, so the fix is there, with a platform variant. P6 · S.
- Progress dots + "STEP 2 OF 8" + Back/Next: three progress indicators. Dots alone. P1 · S.

### 3.10 Dynamic Type (`38`–`40`, accessibility-extra-large)

- Setup card titles truncate ("Finish settin…", "Add a start…") — `lineLimit(2)` on the row
  text with the button claiming the width. You tab rows truncate ("Training bloc…",
  "Change pass…") — `SettingsRow` has `lineLimit(1)` on both title and value. iOS Settings
  wraps titles and drops values to a second line at AX sizes. **Change:** `lineLimit(nil)`
  with a `ViewThatFits` (H → V) at `.accessibility1` and up. P4 · S.
- The period bar's date wraps to two lines while Today stays a pill; after 3.2 this goes away.

## 4. Bugs

| # | Screen | What | Repro | Evidence |
|---|---|---|---|---|
| B1 | Event sheet | The elevation chart's `AreaMark` fill extends ~55pt below the chart's frame and paints under the difficulty dots row ("Moderate") | `-apexMockClient`, open Fixture Run, scroll to Elevation | `08-event-sheet-actions.png` — `StreamChartsView.swift:55`, `.frame(height: 96)` at `:102` needs `.clipped()` or the plot area's own frame |
| B2 | Event sheet | A vertical drag starting on the HR/elevation chart neither scrolls the sheet nor changes its detent — `DragGesture(minimumDistance: 0)` wins over the scroll view | same; swipe up from the chart | `07-event-sheet-mid.png` (unchanged after a swipe) |
| B3 | Month | The grid's last row(s) render under the tab bar at the default text size | `-apexMockClient`, Month | `04-schedule-month.png` |
| B4 | Onboarding | Copy names a week view the app does not have | `-apexMockFreshUser` step 2 vs step 8 | `33`, `35` |
| B5 | Sign-in | Text caret is system blue; `.tint` lives on `RootTabView`, not the window | focus any field | `01` (after focus) |
| B6 | Smoke | `testEventEditsOnFixtures` and `testYouOnFixtures` fail on iPhone 17 Pro Max only (known since W13 B, unfixed) — a layout that breaks on the largest phone | `screenshots.sh 'iPhone 17 Pro Max'` | STATUS.md |

## 5. Live pass (seeded stack)

Signed build, `agent@apex.local` on the local stack (`npm run db:reset-local`'s seed: 97
events from `src/data/schedule.json`, 69 exercise definitions, no meals/tiles/blocks). Real
"today" (Sep 21). Sign-in, session restore and the read path all worked first time.

- **Month at real density (`43-live-month.png`):** every cell carries two chips and every
  chip is three to five characters ("Weig…", "Nightl…", "Climb…") — 60 truncated labels on
  one screen, none readable. The weekly pattern (Tue/Thu/Fri lifts, Mon/Wed climbs, a nightly
  stretch) is exactly what a month view exists to show, and dots would show it at a glance.
  Confirms 3.2; raises it from S to the first thing to do on that screen.
- **Library at 69 rows (`44-live-library.png`):** the list itself reads well (name, category
  in mono, stats on the trailing edge). Two things the fixture could not show: long names
  truncate ("Adductor Stretch — L…") because the stats column claims ~40% of the row; and
  "69 EXERCISES" over seven category chips is the chip row earning its place — here it
  should stay, and appear only once the list is longer than a screen. **Change:** stats to a
  second line under the name (mono, muted), so the name gets the full width. P1 · S.
- **Template search with an empty library (`45-live-template-search.png`):** seven type
  chips above "Your library is empty." Filter controls over nothing. Confirms 3.5.
- **Day at real density (`42-live-day.png`):** the same chrome stack as the fixture, now
  with two real cards — "Climbing — ARC Training / Aerobic Restoration & Capillarization" and
  a nightly stretch; the description line earns its place. The first card still starts at
  70% of the screen.

Not exercised live (no data or provider on the seed): Coach with a real key, COROS, meals,
analytics tiles, blocks. Nothing in those screens depends on density beyond what the fixture
showed.

## 6. Left alone on purpose

- Dark-only (D-010). The palette change makes it more coherent, not lighter.
- The tab set and order (D-012).
- Sheets for detail, cover for the tracker, overlay window for toasts (D-032) — all right.
- The tracker's layout, accessory bar, ghost values, finish gate.
- Analytics edit mode; the kebab menu; tap-to-pin on tiles (D-029).
- Workout-type colours (semantic); the `stretching` purple stays.
- Three typefaces. The wordmark face is used once, as it should be.
- Haptics, Reduce Motion, the 44pt audit (W13 D) — nothing to add.
- The coach's confirmation-card model (the user decides) — the product's thesis; the card
  gets a tint, not a redesign.

## 7. Status (2026-09-21, after the orchestrated implementation)

Ten packages, one PR each, every worker an Opus 5 agent on its own worktree and simulator; the
decisions are D-037…D-044. "Done" means merged or green and queued for a hand merge past Vercel's
Hobby deploy cap.

| Finding | Status | PR |
|---|---|---|
| §1.1 / §3.2 Schedule chrome, setup card, month dots, grid, B3 | done — first card 68% → 28.5% | #285 |
| §1.2 / §2 Palette, B5 caret tint, §3.1 sign-in copy | done — web tokens for both clients | #284, #286 |
| §1.3 / §3.5 Builder pills → menus, disclosure, one Add exercise | done — zero pills above the title | #283, #289 |
| §3.7 Tile builder, "6 TILES", KPI label, one-point tile | done — preview pinned, three chips | #291 |
| §3.3 Event sheet block, content-first, B1, B2; day sheet X | done | #288 |
| §3.4 Tracker icon/colour; running-session affordance | done | #292, #297 |
| §3.6 Coach empty state, bubble, card date/tint, no-key composer | done (a mid-thread key bar was added so a 402 keeps a CTA) | #292 |
| §3.8 You root, Training regroup, blocks, library, detail, COROS, connector; §3.10 rows | done | #287 |
| §3.8 avatar circle | **withdrawn** — the navy is the goat SVG's own disc; 24 avatars carry 24 disc colours | — |
| §3.9 Onboarding 8 → 4, one indicator, B4 copy | done — Swift-only grouping | #296 |
| §3.10 setup card wrapping | done | #285 |
| §4 B6 Pro Max smoke (two bugs) + a third on the 17e | done — toast fixed in the view, two test guards | #290 |
| §5 library at 69 rows | done | #287 |

Corrections the workers made to this review, kept as written above so the reasoning survives:
Start stays primary on a completed workout (§3.3); the running timer belongs in the time column,
not the completion control (§3.4); "Sport appears when Type is cardio" must also show a set value
(§3.5); `onboarding_dismissed` cannot persist the setup card's close (§3.2); "three progress
indicators" overstates it — Back/Next is navigation (§3.9); the review undercounted the web's
hardcoded hexes (§2); "1 session" is wrong for a nutrition tile's one-point case (§3.7).

Follow-ups, none blocking: `SearchablePickerSheet` needs an id hook and a disabled reason;
`ChatCopy.emptyWithKey` is dead; `#b91c1c` as web text at two `app.css` sites is 3.4:1; the cold
avatar discs are a web-asset choice; the bash-guard hook resolves a relative or `$VAR`
`-project` against the shell's cwd (a peer session is fixing it); fleet mode's union proof times
out when Xcode builds share the Mac; every snapshot suite is to be re-recorded on the iPhone 17.

## Regenerating the evidence

```bash
cd ios && xcodegen generate
xcodebuild -project Apex.xcodeproj -scheme Apex -configuration Local \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/dd build
xcrun simctl install booted build/dd/Build/Products/Local-iphonesimulator/Apex.app
xcrun simctl launch booted com.shanehaynes.apextraining -apexMockClient -apexMockHasKey
xcrun simctl io booted screenshot ios/build/review/<name>.png
xcrun simctl ui booted content_size accessibility-extra-large   # the Dynamic Type pass
```

The idb route (`brew install idb-companion`) needs the Xcode 26.6 Command Line Tools
installed with sudo; it was not available to this session, so the walk was screenshot-driven
and every label claim above was confirmed against the Swift source.
