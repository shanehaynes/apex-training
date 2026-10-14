# W16 — Apple Health

**Machine:** both (M0, M2b, M3b Linux · M1, MT, M2i, M3i, M4 Mac) · **Depends on:** W4, W11, W12;
1.0 App Review approval before M1 merges · **Unblocks:** Apple Watch companion (later)
**Status:** not started — brief drafted 2026-10-14 (D-056 supersedes D-018)

## Goal
Apex is a citizen of the Apple Health ecosystem: a workout finished in the tracker shows up in
Health and Fitness as an Apex-branded `HKWorkout` (no energy written, so it does not move the
rings); a Watch, Garmin-via-Health or Whoop-via-Health workout
flows into the schedule the way a COROS activity does (match, fill, HR streams, ledger dedup);
last night's sleep, HRV, resting HR, steps and body mass reach the coach's `<physiology>` block;
body weight and logged meals go to Health. Every category is a separate opt-in, off by default,
stored on the server so disconnect, status and purge mirror COROS, and the server refuses data
for a category that is off.

Out of scope, on purpose: an Apple Watch companion app (its own target, release surface and
review); GPS routes (`HKWorkoutRoute` — keeps App Privacy "Location: No"); the #417/#419 tracker
parity fields on iOS (RPE, session note — a different lane; M1's effort score stays nil until it
lands).

## Order and gates
```
M1 iOS write (Mac, no migration; merges after 1.0 is approved) ──▶ 1.1.0
MT iOS in-app terms re-acceptance (Mac) ──────────────┐   must be released and adopted
M0 migration (Linux, HELD) ─▶ M2b backend apple ──────┴─▶ privacy bump ─▶ M2i iOS read ─▶ M4 meals
                                       └─▶ M3b daily metrics + coach ─▶ M3i iOS metrics + weight (after M2i)
```
M1 ∥ MT ∥ M0. M2b after M0. M3b after M2b (it needs the `apple` row and its categories). M2i
after M2b **and** the privacy bump. M3i after M3b and M2i (server-side toggles). M4 after M2i.
Backend before client (MASTER principle 5): each backend PR ships fixtures in `ios/Fixtures/` and
an integration test. HELD PRs (every iOS milestone that touches entitlements, Info.plist,
PrivacyInfo or project.yml, plus M0 and the `scripts/ci-guards.sh` line) wait on Shane's
`shipit`. Worktrees: `scripts/git-new.sh feat/w16-<milestone> "W16 <milestone>: <files>"`,
`--no-install` for Swift-only.

## Milestones

### M1 — Write finished sessions to Health (iOS only; ships 1.1.0) · Mac
**Merge only after 1.0 is approved**: M1 puts `MARKETING_VERSION` 1.1.0 and the HealthKit
entitlement on `main`, and any 1.0 rebuild for App Review must not carry them.

**Design.** The `HKWorkout` is written **at finish time inside `TrackerModel.requestFinish`**
(`ApexFeatures/Tracker/TrackerModel.swift:580-636`, beside `activity.end` at :632) from local
state — event, `startedAt`, `elapsed`, groups. It does not depend on the server, works offline,
and sidesteps the gap where an offline `.finish` lands after the tracker closes with no listener.
Cancel-after-finish (:758) deletes the workout. Quick-complete never writes (no measured times).
Only tracker-finished sessions count. Known gap, left for a later brief: a web `edit-times`, an
uncomplete or delete elsewhere, or a finish the server refuses does not update or delete the
HKWorkout.

Scope:
- New ApexKit product **`ApexHealth`** (mirror `ApexActivity` in `Packages/ApexKit/Package.swift`;
  depends on ApexCore only; not MainActor-default so observers run off-main; the widget never
  links it): `HealthStore.swift` (protocol), `HKHealthStoreAdapter.swift`, `FakeHealthStore.swift`,
  `HealthWorkoutPublisher.swift` (+ `NoHealthPublisher`). ApexFeatures gains `ApexHealth` as a
  target dependency and `project.yml` links it into ApexTests, as ApexActivity is.
- ApexCore (Linux-tested, no HealthKit import): `Health/HealthWorkoutDraft.swift` — kind, start,
  end, title, `syncIdentifier = "apex:<eventId>|<eventDate>"`, `syncVersion` = unix seconds of
  finishedAt (effort score left out until RPE parity; see below). Kind from `WorkoutEventBase.type` and `sport`
  (`ApexCore/Models/Schedule.swift:27-59`; `sport` is one of running/biking/swimming/climbing/
  other, phase37): weights → `.traditionalStrengthTraining` (`.functionalStrengthTraining` when
  a cardio exercise is in the main work — a cardio warm-up does not count); climbing / outdoor-climbing → `.climbing`; cardio by
  sport — running → `.running`, biking → `.cycling`, swimming → `.swimming`, climbing → `.climbing`, other or
  nil → `.mixedCardio`; yoga → `.yoga`; stretching / morning-routine → `.flexibility`; else `.other`.
- Adapter: `HKWorkoutBuilder.beginCollection` → metadata `HKMetadataKeySyncIdentifier`,
  `HKMetadataKeySyncVersion` (a re-save replaces, never duplicates), `HKMetadataKeyExternalUUID`,
  `HKMetadataKeyWorkoutBrandName: "Apex"` → `endCollection` → `finishWorkout`. No fabricated
  energy or HR. Delete by `HKQuery.predicateForObjects(withMetadataKey:)` on the sync identifier.
  Effort is a hook only: under `#available(iOS 18)`, `relateWorkoutEffortSample` when
  `effortScore` is set — that milestone must also request share authorization for
  `.workoutEffortScore`; M1 does not.
- Wiring: `TrackerDependencies.swift` gains `health: any HealthWorkoutPublishing`;
  `Apex/AppModel.swift:192-214` builds the adapter (fake under `-apexUITest` and
  `-apexMockHealth <authorized|denied|unavailable>`, flag in `Apex/Mock/MockEnvironment.swift`).
- You tab: `YouRoute.appleHealth` (`Profile/YouServices.swift`), `HealthModel` + `AppleHealthView`
  in `ApexFeatures/Integrations/` on the `CorosModel`/`CorosView` pattern; row after COROS in
  `YouTab.swift:173-182`. **M1 toggle state is device-local and keyed by owner**
  (`apex.health.<userId>.workoutsWrite` in UserDefaults — not a global key like the onboarding
  nudge, so a second account never inherits the first one's opt-in); M2i migrates it to the
  server once, for that owner. Toggle ON → `requestAuthorization(toShare: [.workoutType()],
  read: [])`; denied renders "Denied in Health" with the path to allow it. No draft past a
  plausible session length (6 h; 14 h for outdoor climbing): the tracker has no pause, and a
  session left open overnight is not a 15-hour workout (5.1.3, accurate data).
- HELD: `Apex/Apex.entitlements` (+`com.apple.developer.healthkit`), `Apex/Info.plist`
  (+`NSHealthUpdateUsageDescription` only — the share string waits for M2i so the 1.1 review is
  write-only), `project.yml` (`- sdk: HealthKit.framework`, `ApexHealth` on the Apex target and
  ApexTests, `MARKETING_VERSION` 1.1.0), `scripts/ci-guards.sh` (add `HealthKit` to the ApexCore
  import ban). `PrivacyInfo.xcprivacy` unchanged (writing is not collection; UserDefaults is
  already declared).
- Console (approved by Shane 2026-10-14): enable HealthKit on the App ID (the Push precedent:
  profiles regenerate on the next archive); mention Health in the App Store description of the
  1.1 version (guideline 2.5.1) — not 1.0's, which does not write to Health.
- Docs: `app-store.md` §1 Health row and the review-notes item that says "does not read
  HealthKit" reworded ("writes workouts to Health; reads nothing"); `testing-and-ci.md` App Store
  gate line; `check-deinits.sh` (D-031) for new classes.

Acceptance:
- [ ] `swift test --package-path ios/Packages/ApexCore`: draft mapping vectors (every type and
      sport value), identifier and version, nil draft when `startedAt` is missing.
- [ ] `ApexTests/TrackerModelTests` with a `HealthSpy` (the `ActivitySpy` pattern): finish
      publishes one draft with real instants; toggle off publishes nothing; cancel-after-finish
      deletes; offline finish still publishes; the toggle of user A is off for user B.
- [ ] `YouSnapshotTests` row + `apple-health` screen; smoke `testYouOnFixtures` with
      `-apexMockHealth authorized` reads "Writing workouts".
- [ ] Device (Shane): a finished workout appears in Health with Apex as source and the right
      type; cancel removes it; a second finish of the same occurrence replaces, not duplicates.
- [ ] Merged after 1.0 is approved; released as 1.1.0 by `testflight.yml`. The first upload is
      also the proof that a write-only app passes ITMS-90683 without `NSHealthShareUsageDescription`
      — it does not: the 2026-10-14 upload (run 38606595787) was refused, so the key ships in 1.1,
      worded for M2's read and never shown until M2 asks.

### MT — In-app terms re-acceptance for a signed-in user · Mac
Why: bumping `PRIVACY_VERSION` makes every JWT route answer 403 `terms-acceptance-required`
(`api/_lib/auth.ts:106-109`), and the app asks for acceptance only on the invite / set-password
path (`AppModel.swift:427-430`, `loadTermsNeed` :483). A signed-in iOS user would be locked out
with nowhere to accept. The privacy bump that M2i needs (below) waits until this ships.

Scope: detect the 403 body (and the profile's terms state on launch), present a non-dismissable
sheet with the changed documents and an Accept button that calls the existing acceptance
endpoint the web's modal uses, then retry. Mock flag `-apexMockTermsStale`.

As built: `ApexClient.notices` announces the 403 (one consumer, `AppModel`); a background
`GET /api/terms-acceptance` after sign-in catches it before any request does, and fails quiet
offline. `TermsUpdateView` *covers* the tabs (an opaque overlay, modal for VoiceOver) without
unmounting them, so a workout open in the tracker keeps its state; the screen meets the user
when the tracker closes. A 403 that lands after the user is already current (set-password's
acceptance racing the first reads) re-reads the status and shows nothing; a burst of 403s asks once. The write queue **pauses** on the 403
instead of refusing the op (`RetryPolicy`), and accepting resumes it — a set logged in the gap
lands, an outbox write is not dropped.

Acceptance:
- [x] Unit test: a 403 `terms-acceptance-required` from any endpoint raises the sheet once, and
      Accept clears it and retries.
- [x] Smoke leg on `-apexMockTermsStale`; snapshot of the sheet.
- [ ] In a released build that most testers have installed **before** `PRIVACY_VERSION` moves.

### M0 — Migration `phaseN_apple_health.sql` (one file for M2 and M3) · Linux · HELD
Claim `N` with `scripts/next-phase.sh` at PR time. SQL before code; the account export reads
`daily_metrics` the moment this deploys, so the table must exist in prod first.
- `provider_connections.provider` CHECK → `IN ('coros','apple')`; `+ categories jsonb NOT NULL
  DEFAULT '{}'` (keys allowlisted in the handler — the phase41 posture).
- `provider_activity_imports.mode` CHECK → `('created','filled','skipped')`.
- New `daily_metrics`: `user_id` (FK `auth.users` cascade, on the `user_id` line inside a
  `CREATE TABLE IF NOT EXISTS` body so `account.test.ts` sees it), `date`, `provider`,
  `sleep_minutes`, `sleep_stages jsonb`, `sleep_start`/`sleep_end timestamptz`,
  `hrv_sdnn_ms numeric`, `resting_hr int`, `steps int`, `body_mass_lb numeric`,
  `body_mass_at timestamptz`, `sources jsonb`, `updated_at`; PK `(user_id, date, provider)`.
  Service-role only — the phase52 RLS block verbatim.
- `profiles` `+ body_weight_updated_at timestamptz`, `+ body_weight_source text`.
- `notify pgrst, 'reload schema'`; `npm run db:reset-local && npm run db:types` committed (TS
  and Swift generated types); `'daily_metrics'` added to `USER_DATA_TABLES`
  (`api/_lib/handlers/account.ts`) in the same PR (the #386 precedent).

Acceptance:
- [ ] `migration-numbering`, `rls-coverage`, `account` tests green; `scripts/db-types.sh --check`
      clean; `prod-schema-check` exit 0 after Shane pastes it.

### M2b — Backend: Health workouts in as provider `apple` · Linux
The phone *is* the provider: activities arrive in the body and there is no token
(`handleSyncAction` skips `getFreshAccessToken` for `apple`).
Contract — all `POST /api/provider-sync` (JWT; bucket `providerSync` 60/h; `client:'ios'`
required on apple actions except `status` and `disconnect`):
```
{ action:'connect', provider:'apple', client:'ios', timezone,
  categories:{ workoutsWrite?, workoutsRead?, dailyMetrics?, bodyMass?, mealsWrite? } }
  → { ok, apple:{ status:'connected', connectedAt, lastSyncedAt, categories } }     // upsert; auto_sync=false
{ action:'set-categories', provider:'apple', categories:{ …partial } }
  → { ok, categories } | 409 'not-connected'
{ action:'status' } → { coros:{ …unchanged }, apple:{ status, connectedAt, lastSyncedAt, categories } }
{ action:'disconnect', provider:'apple', purgeMetrics?:bool } → { ok, purged:{ dailyMetrics:n }, notice }  // apple wording
{ action:'preview', provider:'apple', client:'ios', timezone, activities:AppleActivity[1..100] }
  → { proposals:[Proposal], skipped:[{ activityId, reason }] }
{ action:'apply', …as preview, decisions:[{ activityId, action:'fill'|'create'|'skip', targetEventId?, eventDate? }] }
  → { created, filled, skipped, errors }
{ action:'ingest', …as preview }     // unattended: create unmatched, never fill
  → { created, skipped:[{ activityId, reason }], pending:[Proposal], errors }
  reason ∈ 'own-app' | 'duplicate' | 'in-progress' | 'out-of-window' | 'already-imported'
AppleActivity = { activityId:<HKWorkout.uuid>, activityType:int, activityName, sourceBundleId, sourceName,
                  startUtc, endUtc, durationSec, distanceMeters?, elevationGainMeters?, avgHr?, maxHr?,
                  calories?, summaryExtras?, streams?:{ hr:[[sec,bpm]] ≤ 2000 } }
```
Rules:
- **Consent is enforced here.** `preview`, `apply` and `ingest` answer 409 `category-off` unless
  `categories.workoutsRead`; 409 `not-connected` without an `apple` row. `connect-start` and
  `set-auto-sync` answer 400 for `apple` (no OAuth; `auto_sync` stays false, so the nightly cron
  never lists apple rows — `providerCron.ts:67` remains a second guard).
- **The window comes from the batch, not the watermark.** For apple, `loadSyncContext` loads
  occurrences and completions from `max(now−30d, min(startUtc) − 24h)`, not
  `last_synced_at − 48h` (`sync.ts:120-133`), so a late Watch sync or the second batch of a first
  sync still finds its plan. `recordSync` runs only when nothing is pending (COROS parity,
  `sync.ts:494-496`).
- **Dedup against tracker sessions, not only streams.** A Watch workout recorded alongside an
  Apex tracker session must not become a second workout: an activity overlapping a *finished*
  `workout_sessions` row (`started_at`/`finished_at`, any provider or none) is skipped as
  `duplicate`; one overlapping an *open* session is skipped as `in-progress` **without** a ledger
  row, so the next ingest after the finish re-evaluates it as a duplicate. Cross-provider
  overlap with `activity_streams.summary` (`startUtc` ±120 s, duration ±10 %) is `duplicate`
  too. Attaching the Watch HR to the Apex session is a later brief.
- **Skip rows.** `mode:'skipped'` ledger rows carry `event_id = '-'` and `event_date` = the
  activity's local date (both columns are NOT NULL); `applyEditTimes`' import count
  (`trackerSession.ts:505-515`) excludes `mode='skipped'`, so a skip never locks a session's
  times.
- **Declining a fill imports standalone** (COROS parity); `'skip'` is the separate "Don't import"
  choice and is rejected for coros.
- Idempotency: `activityId` is the ledger PK; every write upserts with the ledger last; re-sends
  of ledgered ids are no-ops, so a reinstall that re-reads 30 days converges.

Scope:
- `api/_lib/providers/connection.ts`: `SyncProvider` widened; `connectLocal`, `setCategories`,
  `parseCategories`; `connectionStatus` emits `categories`; per-provider disconnect notice.
- `api/_lib/handlers/providerSync.ts`: `parseProvider`, the new actions, the per-provider action
  allowlist, `status.apple`, the client gate, the category gate.
- `api/_lib/providers/sync.ts`: `loadSyncContext` takes `activities` and a window; the
  `'Synced from COROS'` subtitle (:573) becomes per-provider; `startUtc` bounded to
  `[now−30d, now+5min]`; the dedup rules above; the `'skip'` decision; `runIngest` exported.
- `api/_lib/trackerSession.ts`: the edit-times import count excludes skipped rows.
- New `api/_lib/providers/apple/activity.ts`: body parser + `mapActivityType` keyed on the
  **integer** `HKWorkoutActivityType` (pin the table against the SDK header on a Mac). Apple
  must not go through the COROS label mapper: `coros/mapSport.ts` sends "Traditional Strength
  Training" to `outdoor-climbing` via `/trad/`.
- `downsample` moves from `coros/client.ts:455` to `providers/streams.ts`; `src/lib/db/types.ts`
  `SyncProvider`; `src/components/modal/SyncMetrics.tsx` `PROVIDER_LABELS.apple`.
- D-051 holds for free (`endLiveActivities` runs inside `writeActivityRecords`).
- Docs: `backend-changes.md` W16 section.

Acceptance:
- [ ] `provider-sync.test.ts`: apple connect / set-categories / status / disconnect / client
      gate / category gate; `connect-start` and `set-auto-sync` refused for apple.
- [ ] New `apple-activity.test.ts`: parser bounds; the mapper table including the
      "Traditional Strength" trap.
- [ ] `integration/provider-sync.integration.test.ts`: apple fill, create, skip, replay; a
      Watch workout overlapping a finished tracker session is `duplicate`; overlapping an open
      one is `in-progress` with no ledger row; an activity 5 days old matches its plan.
- [ ] `edit-times` still allowed on a session with only a skipped ledger row.
- [ ] `provider-cron.test.ts`: apple rows absent from the nightly list.
- [ ] Fixtures: `ios/Fixtures/provider-status.json` (apple block), `provider-preview-apple.json`.

**Privacy bump (approved by Shane 2026-10-14; after M2b merges, after MT is adopted, before M2i ships).**
`legal/privacy-v2.md` + `PRIVACY_VERSION` in `src/lib/legal/versions.ts` — one bump, with text
that already covers M3: what Health categories Apex reads, that they live on Apex's servers,
and that daily metrics ride in the coach's context to **Anthropic** (guideline 5.1.2(i): third-
party AI needs explicit permission, so the `dailyMetrics` toggle copy names it too).
`app-store.md` §1 Health → **Yes**; the review notes' external-services item; §5 rows for
5.1.3 (no ads, no data mining, no iCloud) and 5.1.2(i); the recording script's permission step.

### M2i — iOS: read Health workouts · Mac
Backend contract consumed: M2b (`backend-changes.md` W16). Absent `apple` in `status` = not
connected. Ships after the privacy bump.

Scope:
- `ApexHealth/HealthWorkoutReader.swift`: `HKAnchoredObjectQueryDescriptor` on `.workoutType()`
  with a start predicate of now−30d on first connect (no reading years of history the server
  would refuse; workouts older than 30 days are not imported); own source excluded
  (`NOT predicateForObjects(from: .default())`); HR samples per workout
  (`predicateForObjects(from: workout)`); `enableBackgroundDelivery(.immediate)` +
  `HKObserverQuery` — the observer only enqueues; `WriteQueueDriver` sends.
- **Its own queue lane, `SessionKey.health`**, not `.outbox`: the outbox is FIFO and a gave-up
  op at its head blocks meal and builder saves behind it (`WriteQueue.swift:273-283`). In the
  health lane, 429 retries with backoff; 409 `not-connected` / `category-off` drops the op,
  refreshes `status` and shows the toggles as the server has them.
- ApexCore: `Models/Health.swift` (`HealthWorkoutImport`, payloads, `Downsample.evenly(max:
  2000)`); `WriteQueueStore` `case healthIngest(HealthIngestPayload)`; `Endpoint` (`provider:`
  already exists on `providerPreview`; add it to apply / status / disconnect, and add `connect`,
  `set-categories`, `ingest`); `Integrations.swift` (`ProviderStatusResponse.apple`);
  `CacheStore` `case healthAnchor` and `case healthPending` (per owner, purged on account switch).
- Flow: read → batch → enqueue `.healthIngest` (the op holds the activities, so it is durable)
  → persist the anchor after the enqueue → on landing, `pending` proposals are **saved to
  `healthPending` keyed by UUID before anything else**, and stay there — badge on the You row and
  a banner on Schedule — until the user decides in the COROS confirm sheet, through a
  `ProviderSyncModel` extracted from `CorosModel.swift:145-242` (parameterised by provider;
  `CorosModel` keeps OAuth) → `apply` with the activities re-read from HealthKit by UUID → the
  decided entries leave `healthPending`. A background ingest, an abandoned sheet or a kill
  never loses a match.
- `HealthModel` toggles move to the server (`connect` on first ON, `set-categories` after); M1's
  per-owner local flag migrates once, then is deleted.
- HELD: `Info.plist` `NSHealthShareUsageDescription` (already present since 1.1 — check its wording
  still matches what M2 reads); entitlement
  `+com.apple.developer.healthkit.background-delivery`; `PrivacyInfo.xcprivacy`
  `+NSPrivacyCollectedDataTypeHealth`.

Acceptance:
- [ ] ApexCore: payload round-trip, downsample, anchor and pending keys, endpoint bodies.
- [ ] `ApexTests`: reader over `FakeHealthStore` — one op per batch; anchor saved after enqueue;
      own-source predicate and 30-day start asserted; toggle off → no query; a landed ingest
      with pending proposals survives a model teardown; a 409 drops the op and turns the
      toggle off; a failing health op does not block a queued meal. `ProviderSyncModelTests`
      through `YouTransport`. Snapshots re-recorded.
- [ ] Smoke: `-apexMockHealth authorized` seeds fake workouts → ingest → confirm sheet → toast.
- [ ] Device (Shane): a Watch strength workout fills a planned occurrence with HR streams; a run
      with no plan is created as `apple-<uuid>`; a Watch workout recorded during an Apex tracker
      session is not imported; the Apex-written workout from M1 is never re-imported.

### M3b — Backend: daily metrics, body weight both ways, coach · Linux
```
POST /api/daily-metrics { provider:'apple', timezone,
  days:[{ date, sleepMinutes?, sleepStages?:{ core, deep, rem, awake }, sleepStart?, sleepEnd?,
          hrvSdnnMs?, restingHr?, steps?, bodyMassLb?, bodyMassAt?, sources? }] (1..62) }
  → { ok, upserted, profileBodyWeightLb? }
  | 409 'not-connected' | 409 'category-off' { category } | 400 field-named
GET  /api/daily-metrics?start&end (≤ 400 days) → { days }
```
- Rate limits: POST in `providerSync`, GET in `reads`.
- One upsert per row on `(user_id, date, provider)`; absent fields untouched, explicit `null`
  clears (HealthKit delivers piecemeal: steps all day, sleep next morning).
- The phone owns the day: sleep is attributed to the date it ended; `hrvSdnnMs` is the mean of
  that day's SDNN samples; `restingHr` is the day's latest `restingHeartRate` sample; `steps` the
  statistics sum; `bodyMassLb` the day's latest sample with its instant in `bodyMassAt`.
- Category gate: sleep / HRV / resting HR / steps need `categories.dailyMetrics`; `bodyMassLb`
  needs `categories.bodyMass`; a field from an off category is a 409 `category-off` naming it.
- **Body weight never moves backwards.** `bodyMassLb` writes `profiles.body_weight_lb` +
  `body_weight_updated_at` + `body_weight_source='apple'` only when `bodyMassAt` is newer than
  `body_weight_updated_at`; a backfilled or older sample leaves a newer manual entry alone.
- `GET /api/profile` already returns `weightUnit` and `bodyWeightLb` (`profile.ts:125-126`); it
  gains `bodyWeightUpdatedAt` and `bodyWeightSource`. `PATCH body_weight_lb` stamps
  `updated_at = now()` and `source='user'`.

Scope:
- `api/_lib/handlers/dailyMetrics.ts` + `api/_lib/services/dailyMetrics.ts` (bounds: sleep
  0..1440 min, resting HR 20..250, HRV 0 < x < 1000 ms, steps 0..200000, mass 0 < x < 1500 lb,
  date within `[today−90d, today+1d]`); route in `api/_lib/app.ts`; disconnect `purgeMetrics`
  wired.
- Coach: `PhysiologyInputs.dailyMetrics` (`src/lib/physiology/types.ts`); a sixth parallel fetch
  in `api/_lib/coach/physiology.ts`; `computeSleep` / `computeRestingHr` / `computeSteps` /
  `computeBodyMass` in `compute.ts`; `computeHrv` prefers daily SDNN and never mixes it with
  activity HRV; `describe.ts` adds lines inside the existing `<physiology>` tags, each omitted
  when empty — `prompt.ts` and `context.ts` untouched. The recovery doctrine already tells the
  coach what to do with sleep, HRV and resting HR; M3b is what finally supplies them.
- Mixed-provider load: Apple carries no `trainingLoad`; `computeLoad` counts COROS only (accepted
  for M3; HR-derived load later).

Acceptance:
- [ ] `daily-metrics.test.ts` (merge, null-clears, category gate, body-weight recency),
      `coach-physiology.test.ts`, `physiology.test.ts`, `profile.test.ts`, `router.test.ts`,
      `account.test.ts` green.
- [ ] `eval-analyst` run before merge — prompt text moves and the gate baseline is HELD.
- [ ] Fixtures: `daily-metrics.json`; `profile.json` regenerated.

### M3i — iOS: daily metrics + body weight both ways · Mac
Backend contract consumed: M3b. After M2i (server toggles, health lane).

Scope:
- `ApexHealth/DailyMetricsReader.swift`: sleepAnalysis (anchored, category), HRV SDNN, resting HR,
  bodyMass (anchored; own source excluded — the loop guard); steps via
  `HKStatisticsCollectionQuery` daily sum (dedups phone + watch). Aggregation per M3b.
- ApexCore `Models/DailyMetrics.swift`; `WriteQueueStore` `case dailyMetrics(payload)` in the
  health lane with pending-tail merge by date (like `.save`); `Endpoint`; `Profile.swift` gains
  `bodyWeightUpdatedAt` and `bodyWeightSource`.
- `ApexFeatures/Profile/BodyWeightView.swift` (the `HeartRateZonesView` form shape): save →
  `PATCH /api/profile`, then `health.writeBodyMass` when `bodyMass` is on
  (sync id `apex:bodyweight:<iso>`).

Acceptance:
- [ ] ApexCore: day attribution, aggregation, merge rule, payload encode.
- [ ] `ApexTests`: reader over fake samples yields the expected days; an Apex-written mass is
      never re-posted; snapshots.
- [ ] Device (Shane): last night's sleep shows in the coach's physiology within one foreground.

### M4 — Meals as dietary samples · Mac
Scope: `ApexHealth/NutritionWriter.swift`; `ApexCore/Health/DietaryDraft.swift` (kcal, protein,
carbs, fat total, fiber, sugar, saturated fat — no HK type for alcohol or trans fat; sync id
`apex:meal:<mealId>:<type>`, version = updated instant; time nil → 12:00 local). `MealsModel`
writes after enqueue when `mealsWrite` is on; the delete path removes. No backend change.

Acceptance:
- [ ] ApexCore draft vectors; `MealsModelTests` spy; a logged meal appears under Nutrition on a
      device.

## Decisions (D-056 in decisions.md)
1. HealthKit code lives in a new `ApexHealth` product; `HealthKit` joins the ApexCore import ban.
2. Write at finish time from local state, not on `.finished` landing; quick-complete never writes.
3. Toggles are `categories` on the `apple` `provider_connections` row, not `profiles`, so
   disconnect, status and purge mirror COROS, and the server enforces them; M1 holds the one
   toggle locally, per owner, until M2i.
4. Apple imports reuse the confirm sheet: matches ask and wait in `healthPending`, unmatched
   create silently (`ingest`); declining a fill imports standalone, "Don't import" skips.
5. Disconnect keeps imported workouts (COROS parity), with opt-in `purgeMetrics`.
6. No routes (Location stays No). Steps via statistics, not samples. The UUID of an Apex-written
   HKWorkout stays on the phone; an imported workout's UUID is its server ledger key.
7. Privacy policy bumps once, after M2b and after MT is adopted, with text covering M3 and naming
   Anthropic for daily metrics — Shane confirms the bump.
8. Apple carries no training load; `computeLoad` counts COROS only until HR-derived load exists.
9. Health ops get their own queue lane; 409s drop, 429s retry.

## Not verified by the planning pass
HealthKit API signatures and `HKWorkoutActivityType` raw values (from memory — pin against the
SDK header on a Mac in M2b); `get_meals` `updated_at` for a later web-meal catch-up; evals
coverage of the physiology block; the ASC console steps for a Health-reading build; the
acceptance endpoint MT calls (read the web's re-acceptance modal first).

## Session log
- 2026-10-14 · Mac · Brief drafted from the approved plan: scope, data home and order decided by
  Shane 2026-10-13; three read-only explorers and two design passes (iOS, backend) reconciled.
  The adversarial review found the terms lock-out (→ MT), dedup against tracker sessions, lost
  pending matches, the watermark window, body-weight recency, the outbox head-of-line block and
  owner-keyed toggles; all folded in. No code.

- 2026-10-14 · Mac · Shane approved the privacy bump and the two console steps; M1 started on
  `feat/w16-m1-health-write`.

- 2026-10-14 · Mac · MT built (`feat/w16-mt-terms-reaccept`): client notice, background check,
  in-place screen, queue pause on the gate. ApexCore, AppModel, snapshot and smoke tests green.
  The release box is Shane's (ship before `PRIVACY_VERSION` moves).

## Next brief
**M1 — Write finished sessions to Health.** Goal: a tracker finish writes an Apex-branded
`HKWorkout` with the real start and end, the mapped activity type and sync metadata; cancel
deletes it; a You → Apple Health screen holds one per-owner toggle. Scope: the M1 section above,
nothing from M2. Acceptance: the five M1 boxes. Owns: `ios/Packages/ApexKit/Sources/ApexHealth/`
(new), `ios/Packages/ApexCore/Sources/ApexCore/Health/` (new), `ios/Packages/ApexKit/Package.swift`
(the product, its target, the ApexFeatures dependency), `ApexFeatures/Tracker/TrackerModel.swift`,
`ApexFeatures/Tracker/TrackerDependencies.swift`, `ApexFeatures/Integrations/{HealthModel,
AppleHealthView}.swift`, `ApexFeatures/Profile/{YouTab,YouServices,YouModel}.swift`,
`ios/Apex/{AppModel.swift,Mock/MockEnvironment.swift}`, the HELD release surface listed in M1
(including ApexTests' link in `project.yml`), `scripts/ci-guards.sh` (one regex token),
`docs/ios/{app-store,testing-and-ci,decisions,STATUS}.md`. Forbidden: any tracker file the
#417/#419 parity lane owns beyond the one `requestFinish` / cancel hook; `legal/`. Mac session.
Open the PR any time; it merges only after 1.0 is approved. **MT** can run in parallel in its own
worktree.
