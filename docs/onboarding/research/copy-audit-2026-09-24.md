# Onboarding copy audit, 2026-09-24

Read-only lane report (O16 part 1), committed verbatim. `main` @ 05b5de9 at audit time, with the calendar (#328) and coach (#331) branches read directly; both merged since. The fix lane `fix/onboarding-copy-audit` works from this table.

**Conclusion.** All 25 tips pass the rules that can be counted. Titles are 5 words or fewer, bodies 32 or fewer, every first sentence has one command verb, and no banned term appears. Only one tip needs a fix (`coros-expired`, which sends the reader to the wrong button). The violations are in the other copy: the checklist, the two intro cards that assume a phone layout, `get-api-key.md` (long sentences), and two uses of "just" outside `content.ts`. The larger problem is the UI itself: several on-screen labels and hints break the rules, so copy that quotes them correctly still teaches jargon. The worst are **est. 1RM**, "This event only", "URL", "token", "Profile → AI Coach", and the connector fold.

## 1. Summary counts

| Checked | Count |
|---|---|
| Intro cards (body, plus action/link labels) | 4 cards, 3 buttons/links |
| Checklist rows (label, hint, action) / extra notes | 5 rows (15 strings) / 2 |
| Tips (title and body) | 25 (50 strings) |
| Help pages / help-index summaries (`src/lib/help/pages.ts`) | 5 / 5 |
| Fixed strings in `GettingStarted.tsx` | 3 |
| Bold labels checked against components | 43 in tips and intro; 112 in help pages (about 25 are external, see §5) |

| Rule broken | Violations |
|---|---|
| Banned term (API key 3, sync 1) | 4 |
| "just" / "simply" | 2 |
| Sentence over 15 words | 8 sentences in 7 rows |
| Reading level (word a non-technical adult may not know) | 5 |
| Copy wrong about the label or where it is (§3, copy side) | 6 |
| UI label or hint is itself the problem (§3, UI side) | 9 |
| Tip counts / command verb in first sentence | 0 |

## 2. Violations (paste-ready)

| # | File | Id / heading | Offending text | Rule | Replacement |
|---|---|---|---|---|---|
| 1 | src/lib/onboarding/content.ts:99 | checklist `key` label | "Add your Anthropic API key" | banned: API key | `Add your key from Anthropic` |
| 2 | src/lib/onboarding/content.ts:112 | checklist `coros` hint | "activities sync in every night" | banned: sync (verb) | `Your COROS runs and rides come in every night, with heart rate, climb and route.` |
| 3 | src/lib/onboarding/content.ts:72 | intro `coach` | "The **Coach** tab … a key from Anthropic first" | API key needs the "(a code)" gloss at first mention; "tab" is wrong on desktop (§3) | `**Coach** answers questions about your training and can plan workouts for you. It needs a key from Anthropic (a code). Getting one takes a few minutes. Anthropic bills you, not Apex.` (31 words) |
| 4 | src/components/onboarding/GettingStarted.tsx:31 | all-done hint | "This list is just here for reference now." | "just" | `Everything is set up. The list stays here for you to look back on.` |
| 5 | src/lib/help/pages.ts:33 | repeating-workouts summary | "what changes just one day" | "just" | `Weekly workouts, and which changes reach one day or every week.` |
| 6 | help/get-api-key.md:76 | Already pay for Claude? | "does not come with an API key. Anthropic does not let other apps … (20w)" | banned: API key; over 15 words | `A Claude Pro or Max plan does not include a key. Anthropic does not let apps like Apex use your plan.` |
| 7 | same:80 | same | "If Anthropic opens a way … (19w)" | over 15 words | `If Anthropic ever lets apps use a plan, we will add it here.` |
| 8 | same:86 | What it costs | two 16-word sentences; **Haiku** | over 15 words; label is "Haiku 4.5" (src/lib/coach/models.ts:94) | `Pick which Claude model answers from the menu next to **Coach**. It sits at the top of the coach. Each choice shows two prices. One is for what the coach reads, one for what it writes. Smaller numbers cost less. **Haiku 4.5**, at the bottom, is the cheapest. Your pick also writes your workout summaries.` |
| 9 | same:92 | If something goes wrong | "…shows under the box when you press **Save key**. (18w)" | over 15 words | `**"That key is not tied to a single workspace"** shows under the box. The key was made with Workspace left on "same as personal account". Go back to step 4 and make a new key with a named workspace. Paste the new one.` |
| 10 | same:94 | same | "…means the key was typed wrong, or it was deleted or ran out. (21w)" | over 15 words | `**"That Anthropic API key was rejected by Anthropic"** means the key is wrong. It may be mistyped, deleted or out of date. Copy it again, or make a new one.` (the quoted UI string is allowed) |
| 11 | help/logging-a-workout.md:3 | intro | "This page explains the two buttons … (20w)" | over 15 words | `Log each set as you do it. This page covers the two buttons on a workout and the grey numbers. It also covers blank sets and the trophies at the end.` |
| 12 | help/calendar-feed.md:24 | step 3 | "Google’s phone app cannot … so this step needs a computer. (16w)" | over 15 words | `Google’s phone app cannot add a calendar from an address. This step needs a computer. Go to calendar.google.com and sign in.` |
| 13 | src/lib/onboarding/content.ts:94 | checklist `template` hint | "Shane’s recurring workouts as a base" | reading level; also a different name for the plan (§4) | `Copy Shane’s starter plan. Change or delete any of it later.` |
| 14 | src/lib/onboarding/content.ts:107 | checklist `connector` hint | "Read-only — it can never…" | reading level | `Ask Claude or ChatGPT about your training. It can look, but never change anything.` |
| 15 | src/lib/onboarding/content.ts:126 | EXTRA_NOTES[0] | "Subscribe … — Profile → Calendar feed." | reading level; the reader is already in Profile | `See your workouts in Apple or Google Calendar. Open Calendar feed, below.` |
| 16 | help/get-api-key.md:27 | step 3 heading | "Open the API keys page" | banned term in running text (the bold **API keys** on line 29 is Anthropic's label, so it is allowed) | `## 3. Go to the keys page` |
| 17 | help/get-api-key.md:66 | step 7 | "the last four letters of your key" | inaccurate: the last 4 include digits | `Apex shows only the end of your key.` |

## 3. Label mismatches

| File | Copy says | UI actually shows | Change | Fix |
|---|---|---|---|---|
| help/repeating-workouts.md:33,37 vs UI | **This event only** (edit) / **This day only** (delete) | `BuilderForm.tsx:296` "This event only" and question text `:285`; `WorkoutModal.tsx:417` "This day only" | **UI**: use "This day only" everywhere | BuilderForm:296 → `This day only`; :285 → `Save to this day only — it leaves the series for good, keeping anything logged — or to the whole series?`. Then help:33,37, `docs/onboarding/MASTER.md:141`, `e2e/mock/builder-recurrence.spec.ts`, `e2e/shots/repeating-workouts.shots.ts`, and re-shoot 04-save-scope. For iOS, `BuilderSheet.swift:130` and `SmokeUITests.swift:576` (touches `ios/`, so a separate PR) |
| help/logging-a-workout.md:51 | **est. 1RM** (explained in the copy) | `lib/tracking/records.ts:474` (summary trophy line); `lib/library/stats.ts:118` / `ExerciseDetail.tsx:27` ("Best est. 1RM", "est. 1RM over time"); `lib/analytics/spec.ts:179` chip "Est. 1RM"; `lib/review/formats.ts:44` (monthly email) | **UI** | Summary: `est. best single lift 216 (190 × 5), up from 206 on Jun 12`. Library stat and chart chip: `Best single lift (est.)`. Then help:51 → `**est. best single lift** comes from the weight and reps of your best set.` Update `records.test.ts` |
| help/logging-a-workout.md:13 | "Tap it again to undo." | the button turns into **Completed** (`WorkoutModal.tsx:341`) | copy | `It then says **Completed**. Tap **Completed** to undo.` |
| content.ts:64 (web intro `plan`) | "the **+** button at the bottom" | desktop has "+ **Add**" at the top right (`TopNav.tsx:58-59`); the phone has it at the bottom | copy | `Start fast with Shane’s starter plan. Change or delete any of it later. Or tap **+** to add your own workout.` |
| content.ts:72 (intro `coach`) | "The **Coach** tab" | desktop shows a "Coach" panel, not a tab (`ChatSidebar.tsx:158`) | copy | see §2 #3 |
| src/lib/onboarding/tips/coros.ts:29 `coros-expired` | "Press **Reconnect** at the top to sign in to COROS again." | the top-bar Reconnect only opens Profile (`ProviderSyncControls.tsx:92`); signing in needs **Reconnect COROS** (`CorosConnection.tsx:70`) | copy | `Press **Reconnect**, then **Reconnect COROS**, to sign in again. On a phone, **Reconnect** is the circling arrows at the top. Nothing you brought in is lost.` (25 words) |
| content.ts:100 checklist `key` hint | "See Get an API key under Help." | the Profile link reads "Help pages" (`ProfileView.tsx:217`); hints render as plain text, so bold does not work (`GettingStarted.tsx:42`) | copy | `The coach and workout summaries stay off until you add it. To learn how, open Help pages, then Get an API key.` |
| src/hooks/useChat.ts:28 (quoted at get-api-key.md:101) | "under Profile → AI Coach (the circle avatar, top left)" | Profile has no "AI Coach". It has group "AI", section "Coach", fold "Anthropic API key" (`ProfileView.tsx:333-370`) | **UI** | `To use the coach, add a key from Anthropic. Tap your picture at the top left, then Anthropic API key.` Update the quote at help:101. The same stale path is at `api/_lib/handlers/account.ts:73` |
| ChatSidebar no-key prompt (:213-232, :311); `AnalyticsCoachPanel.tsx:104` | intro and checklist action say **Add key** | "your own Anthropic API key", button "Add API key", placeholder "Add your API key to chat…" | **UI** | Hint `The coach needs a key from Anthropic (a code). Add one to turn on chat and workout summaries.`; button `Add key`; placeholder `Add your key to chat…`. "How to get a key" is fine |
| Profile key fold `ProfileView.tsx:370`, hint :399-404 | get-api-key.md:56 says **Anthropic API key** (correct today) | the title uses a banned term; the hint has "Workspace", "expiry", "lapses", "server-side" | **UI** (optional) | Title `Anthropic key` (then update get-api-key:56 and its shots). Hint `Paste your key from Anthropic. Help pages → Get an API key shows how.` |
| calendar-feed.md:11; `profile.ts` `calendar-feed` tip | "address" / **Feed URL copied** | hint "this URL" (`ProfileView.tsx:442-443`), toast "Feed URL copied" (:176) | **UI** | Hint `Paste this address into Apple or Google Calendar. Anyone with it can read your schedule. Keep it private, like a password.`; toast `Address copied`; then help:11 → `Apex says **Address copied**.` |
| `connector-first` tip (**Step-by-step guide** is correct, `McpTokens.tsx:121`) | "It can look but never change anything." | the fold shows "URL", "custom connector", `claude mcp add`, "access token", "Tokens are read-only", "Create token", "Bearer", "mint", "N tokens" (:97-137, 162-168) | **UI** | Hint `Ask Claude or ChatGPT about your training. It can look, but never change anything. Tap Step-by-step guide to set it up.` Change token → code in `Create code`, `Code name (for example, Claude Desktop)`, `Copy this code now. You will not see it again. It stops working in a year.` Keep the Bearer detail in the guide only |
| help/repeating-workouts.md:25 (alt caption) | "every occurrence of the series" | the note in `EventExerciseEditor.tsx:316` (and iOS `EditExercisesSheet.swift:32`) | **UI** | `This workout repeats. Changes here reach every day in the series.` Match the caption |
| connect-coros.md:64 | **Sync automatically every night** | checkbox label `CorosConnection.tsx:50` (the quote is accurate, but the label uses "sync" as a verb); hints :40-55 and :64-66, 78-81 say "synced", "syncing", "tokens", "import", "badge", "GPS" | **UI** | Checkbox `Bring in new activities every night (about 11:30 PM Eastern).`, then help:64 matches. Rewrite the hints the same way |
| `meal-first` tip | "Calories fill in from those." | label "Calories *auto from macros*" (`AddMealView.tsx:278`) | **UI** | `Calories *fills in by itself*` |

These are fine and need no change:
- `builder-repeat` says "Turn **Repeat** on". The control is an **Off**/**On** button next to the "Repeat" label (`RepeatPicker.tsx:44-52`). Acceptable; the help page is exact.
- `coach-first-message` uses a curly ’ in **Coach’s Notes**, while the UI (`ChatSidebar.tsx:286`) has a straight '. Only the look differs.

Every other bold label matched its component, including case and punctuation.

## 4. Consistency: one name per idea

| Idea | Names in use | Use |
|---|---|---|
| The template | "Shane’s ready-made weekly plan" (content.ts:64), "starter plan" (:65, :92, library-meals.ts:13), "Shane’s recurring workouts" (:94), "Shane’s workouts" (calendar.ts:19) | **starter plan** |
| Pressing a button | "Tap" (11 tips, most help pages), "Press" (9 tips, get-api-key, connect-coros), "Click" (calendar-feed Google step) | **Tap**; "Click" only in the computer-only Google step |
| Opening Profile | "Tap your picture at the top left" (connect-coros:7), "at the top of the screen" (calendar-feed:7), "press the round picture" (get-api-key:56), "circle avatar" (useChat.ts:28) | **Tap your picture at the top left** |
| The Anthropic key | "key from Anthropic" (intro, builder-coach, get-api-key), "Anthropic API key" (checklist, Profile, ChatSidebar), "API key" (ChatSidebar button) | **key from Anthropic**; **Anthropic key** where a label must be short |
| One day of a repeating workout | "This day only", "This event only", "one day", "occurrence" | **this day only** / **one day** |
| Watch data arriving | "sync in" (checklist), "bring in" (coros tips, help), "come in" (help) | **bring in** / **come in** |
| The Claude/ChatGPT link | fold "AI connector" (McpTokens.tsx:97), checklist "Connect Claude or ChatGPT", tip "Ask Claude or ChatGPT" | name the fold **Claude or ChatGPT**, so the checklist row matches what the user sees |
| Blocks and cycles | tip title "Train in blocks" but the button is **New cycle**; the tip explains block, not cycle | `blocks-first` → `Press **New cycle** to plan several weeks at once. A cycle is blocks in a row, like three hard weeks, then one easy. Each block has a weekly goal, like 6 hours of cardio.` (32 words) |
| Summaries | "post-workout summaries" (content.ts:100, ChatSidebar), "workout summaries" (get-api-key:86) | **workout summaries** |
| "series" | tips and help pages use it because the label is **Whole series** | keep it, but only next to **Whole series**; `workout-recurring` already explains it with "this workout repeats" |

## 5. What I could not verify

- **External labels.** Nothing on other sites was checked: console.anthropic.com (**Billing**, **Settings**, **API keys**, **Create Key**, **Workspace**, "same as personal account", the expiry prompt, the $5 minimum), Apple Calendar (**Calendars**, **Add Subscription Calendar**, **Subscription URL**, **Subscribe**, **Add**), Google Calendar (**Other calendars**, **From URL**, **URL of calendar**, **Make the calendar publicly accessible**), and the COROS app's **Profile → Settings → 3rd Party Apps** and consent screen.
- **Nothing was run.** Rendering was not checked: whether the phone really hides the Sync/Reconnect text (the copy relies on that), what the shots show, whether "Tap a day" works on desktop, or whether Google's phone app picks up a subscribed calendar by itself.
- **Behaviour claims not tested:** "changes follow within a few hours", "a few cents a day", nightly import on by default, and **Save to library** re-filling the meal form.
- **Reading level** was judged by eye plus a script that flags sentences over 15 words. No formal grade-level formula was run.
- **Scope.** All iOS catalog copy except the `plan` card's `iosBody` (which is correct) was skipped.
