# Screens — parity map and navigation

The web has no router: every screen is a boolean in `src/context/calendar.ts` rendered as a
fixed overlay. This table is the iOS navigation model and the parity checklist in one. Every
web surface appears exactly once; the owner column is the workstream that ships it.

Tabs (D-012): **Schedule · Coach · Analytics · You**.

## Schedule tab

| Web | iOS | Owner | Notes / improvements |
|---|---|---|---|
| `Calendar.tsx` → `DayView` (forced on phone) | **Day** (default): week strip (paging, 7 cells, type dots), big date numeral, `EventCard` list with 44pt completion control, meals summary row | W2 | swipe days; long-press a day to add (U6); pull-to-refresh (U17) |
| `MonthView` (desktop only today) | **Month**: 7×N grid, ≤3 chips + "+N", tap day → day sheet, tap chip → event sheet; swipe months | W2 | completion reachable (U7) |
| `WeekView` | omitted (D-009) | — | |
| `TopNav` period controls, Today | toolbar: ‹ › · title · Today; segmented Day/Month | W2 | |
| `MobileBottomNav` FAB (+) → Workout / Meal | toolbar "+" menu | W2 | |
| `DayModal.tsx` | **Day sheet** (`.medium/.large`): workouts + meals + macro rollup; Add workout / Add meal; tap meal → composer | W2 (list), W10 (meals) | |
| `WorkoutModal.tsx` (432 lines) | **Event sheet**: title/date/time inline edit, difficulty dots, `SyncMetrics` badges, stream charts (scrub), exercise list with supersets, Start Workout, Mark Complete, Edit exercises, Edit workout, Delete (occurrence vs series) | W2 (read + complete), W7 (edit/delete), W11 (sync metrics detail) | U5, U14 |
| `TrackerView.tsx` + `TrackerExercise.tsx` | **Tracker** (`fullScreenCover`): header (back, title on its own line, date · elapsed timer, Finish), section groups, set rows (# · target · inputs · remove), cardio row, climbing pitch rows, shadow fill, Add set, Swap exercise (picker), autosave → write queue | W4 | U2, U3, U15, U16, U18, U27–U29 |
| `DurationInput.tsx` | mono field with the digit-buffer model from `ApexCore.DurationBuffer`; numeric pad + accessory bar (`.` free-text escape kept) | W4 | U29 |
| `ConfirmBar`, `ScorePrompt`, `WorkoutSummary` | Finish gate: unlogged confirm → score sheet (mm:ss or rounds+reps, Skip) → summary overlay (streaming recap, PR trophies, full log, Back) | W4 | offline: "PRs pending sync" |
| Live Activity | elapsed timer + title in the Dynamic Island / Lock Screen | W12 | U25 |
| `WorkoutBuilderView.tsx` + `TemplateSearch` + `BuilderForm` + `RepeatPicker` | **Builder sheet** (`.large`): template search (substring, type chips, archive, "Build '<q>'") → form: type chips, sport, scoring, title, date, duration, start/end, repeat (day chips + every N weeks + ends), climbing/cardio fields, location, tags, description, difficulty; scope bar for recurring edits (this only / series) | W7 | native pickers (U9) |
| `EventExerciseEditor.tsx` + `ExercisePicker` | exercise sections editor: `List` with `.onMove` drag handles, per-exercise prescription row (sets/reps/duration/weight/rest), superset chain toggle, remove; picker: search-first, exact-match-or-create, inline create (category, unilateral) | W7 | U10 |
| `BuilderCoachPanel` | builder coach: a chat drawer inside the builder sheet whose single tool updates the draft server-side (`/api/coach-tool` reduce) | W7 | |
| `OnboardingHost` (`WelcomeFlow`, `SetupNudge`) | paged welcome flow on first run; setup nudge card at the top of Day view; dismiss persists via `PATCH /api/profile { onboarding_dismissed }` | W13 | U32 |

## Coach tab

| Web | iOS | Owner | Notes |
|---|---|---|---|
| `ChatSidebar.tsx` | **Thread**: Markdown messages (D-014), streaming cursor, typing indicator, confirmation cards (label, Confirm/Cancel, "1 of N"), Stop, multiline composer with Send, Coach's Notes button, model badge | W6 | U22, U31 |
| — | conversation list (local, D-013): new / resume / delete | W6 | |
| 402 / 429 inline states | same, with a one-tap "Add key" route to You → Anthropic key | W6 | |

## Analytics tab

| Web | iOS | Owner | Notes |
|---|---|---|---|
| `AnalyticsView.tsx` | **Dashboard**: vertical tile list; kebab → Edit / Duplicate / Delete (two-tap); "N excluded" footnote; Edit mode → reorder + S/M/L (D-011) | W9 | U26 |
| `TileRenderer.tsx` | line / area / bar / stacked-bar / kpi / table via Swift Charts over `/api/analytics-compute` | W9 | U13 |
| `TileBuilder.tsx` (543 lines) | **Tile builder sheet**: title, chart type, range (rolling / preset / fixed), bucket, unit, series list (grouped measure picker, aggregation, split-by, top-N, grade scale, filters incl. day-offset filter); live preview via single-spec compute; incompatible pairings dimmed with a visible reason | W9 | |
| `AnalyticsCoachPanel` | analytics coach drawer inside the builder (draft reduce server-side) | W9 | |

## You tab

| Web | iOS | Owner | Notes |
|---|---|---|---|
| `ProfileView.tsx` Getting-started, avatar, account, HR zones, password | **You** root: avatar + name header, grouped sections (Account · Training · AI Coach · Integrations · Data · Sign out) | W11 | U24 |
| `LibraryView` → `ExerciseDetail` → `DefinitionEditor` | **Library**: search + category chips, rows with last-performed and in-N-workouts (U11), archived section; detail: tags, aliases, notes, PR stat card, trend chart, recent sessions; editor sheet with rename-keeps-alias, archive/restore with blast-radius note | W10 | via `/api/query` + `/api/exercise-definitions` |
| Workout templates (in builder search + `/api/workout-templates`) | **Workout library** list under Library (archive/restore) | W10 | |
| `BlocksView` → `BlockDetail` / `BlockEditor` / `CycleEditor` | **Blocks**: list + objectives; detail (block-to-date bars, this-week bars, by-week table incl. attainment (U12), PRs this block); editor (Monday/Sunday snapping, six weekly targets with unit pickers); cycle generator with live dated preview | W10 | `/api/query get_training_blocks`, `/api/blocks`, `resource=cycle` |
| `AddMealView.tsx` + meal rows | **Meals**: day list (from Day sheet too), composer sheet (favorites chips, type row, macro fields, derived kcal placeholder, fat-split validation, save to library) | W10 | |
| AI Coach section: goal, context, API key, model picker (PR #91) | **AI Coach**: goal, context, key save/replace/remove (masked last-4), model picker | W11 | |
| `CoachActivity` | **Activity log** (`/api/mutations-log`, You / Coach badges) | W11 | |
| Calendar feed (ICS URL + copy) | **Calendar feed**: copy, share sheet, "Subscribe in Calendar" (`webcal://`) | W11 | U19 |
| `McpTokens` + `ConnectorGuide` | **AI connector**: endpoint, mint token (one-time reveal), active tokens (revoke), connected apps (disconnect); guide as a pushed screen with the existing illustrations rendered as images | W11 | |
| `CorosConnection` + `ProviderSyncControls` + confirm queue | **COROS**: connect (`ASWebAuthenticationSession`), reconnect, disconnect, auto-sync toggle; Sync now with preview → per-fill confirmation sheet queue → apply | W11 | U30 |
| Sign out, change password | same | W11 | |
| — | **Delete account** (App Store) | W11 | |
| Terms / Privacy (PR #93) | links in About | W13 | |

## Auth (outside tabs)

| Web | iOS | Owner |
|---|---|---|
| `LoginView` (sign in / create / forgot; invite-only copy) | sign-in screen with AutoFill; "invite only — request access" copy; forgot password | W1 (sign in), W2 (recovery + invite links) |
| `SetPasswordView` | set-password screen for invite / recovery sessions | W2 |
| `ConnectApproval` (`/connect` OAuth consent for MCP clients) | stays on the web (the consent page is reached by a browser redirect from an MCP client, never from the app) | — |

## Not ported
Week view (D-009); `/connect` consent page; dev-only agent bridge; review emails (server-side).
