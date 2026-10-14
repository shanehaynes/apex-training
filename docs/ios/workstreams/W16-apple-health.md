# W16 — Apple Health

**Machine:** both (M0, M2b, M3b Linux · M1, M2i, M3i, M4 Mac) · **Depends on:** W4, W11, W12;
1.0 App Review approval before the 1.1 release · **Unblocks:** Apple Watch companion (later)
**Status:** not started — brief drafted 2026-10-14 (D-056 supersedes D-018)

## Goal
Apex is a citizen of the Apple Health ecosystem: a workout finished in the tracker closes the
rings as an Apex-branded `HKWorkout`; a Watch, Garmin-via-Health or Whoop-via-Health workout
flows into the schedule the way a COROS activity does (match, fill, HR streams, ledger dedup);
last night's sleep, HRV, resting HR, steps and body mass reach the coach's `<physiology>` block;
body weight and logged meals go to Health. Every category is a separate opt-in, off by default,
stored on the server so disconnect, status and purge mirror COROS.

Out of scope, on purpose: an Apple Watch companion app (its own target, release surface and
review); GPS routes (`HKWorkoutRoute` — keeps App Privacy "Location: No"); the #417/#419 tracker
parity fields on iOS (RPE, session note — a different lane; M1's effort score stays nil until it
lands).

## Order and gates
```
M1 iOS write (Mac, no migration) ─────────────────────────────▶ 1.1.0 once 1.0 is approved
M0 migration (Linux, HELD) ─▶ M2b backend apple provider ─▶ M2i iOS read ─▶ M4 meals
                            └▶ M3b daily metrics + coach ─▶ M3i iOS metrics + body weight
```
M1 ∥ M0. M3b ∥ M2i. Backend before client (MASTER principle 5): each backend PR ships fixtures in
`ios/Fixtures/` and an integration test. HELD PRs (every iOS milestone — entitlements, Info.plist,
PrivacyInfo, project.yml — plus M0 and the `scripts/ci-guards.sh` line) wait on Shane's `shipit`.
Worktrees: `scripts/git-new.sh feat/w16-<milestone> "W16 <milestone>: <files>"`, `--no-install`
for Swift-only.

## Milestones

### M1 — Write finished sessions to Health (iOS only; ships 1.1.0) · Mac
**Design.** The `HKWorkout` is written **at finish time inside `TrackerModel.requestFinish`**
(`ApexFeatures/Tracker/TrackerModel.swift:580-636`, beside `activity.end` at :632) from local
state — event, `startedAt`, `elapsed`, groups. It does not depend on the server, works offline,
and sidesteps the gap where an offline `.finish` lands after the tracker closes with no listener.
Cancel-after-finish (:758) deletes the workout. Quick-complete never writes (no measured times).
Only tracker-finished sessions count; web-finished backfill is a later brief.

Scope:
- New ApexKit product **`ApexHealth`** (mirror `ApexActivity` in `Packages/ApexKit/Package.swift`;
  depends on ApexCore only; not MainActor-default so observers run off-main; the widget never
  links it): `HealthStore.swift` (protocol), `HKHealthStoreAdapter.swift`, `FakeHealthStore.swift`,
  `HealthWorkoutPublisher.swift` (+ `NoHealthPublisher`).
- ApexCore (Linux-tested, no HealthKit import): `Health/HealthWorkoutDraft.swift` — kind, start,
  end, title, `syncIdentifier = "apex:<eventId>|<eventDate>"`, `syncVersion` = unix seconds of
  finishedAt, `effortScore: Int?`. Kind from `WorkoutEventBase.type`/sport
  (`ApexCore/Models/Schedule.swift:27-59`): weights → `.traditionalStrengthTraining`
  (`.functionalStrengthTraining` when a cardio exercise is in the groups); climbing /
  outdoor-climbing → `.climbing`; cardio by sport (run/ride/swim/hike/row/walk, else
  `.mixedCardio`); yoga → `.yoga`; stretching / morning-routine → `.flexibility`; else `.other`.
- Adapter: `HKWorkoutBuilder.beginCollection` → metadata `HKMetadataKeySyncIdentifier`,
  `HKMetadataKeySyncVersion` (a re-save replaces, never duplicates), `HKMetadataKeyExternalUUID`,
  `HKMetadataKeyWorkoutBrandName: "Apex"` → `endCollection` → `finishWorkout`. No fabricated
  energy or HR. Delete by `HKQuery.predicateForObjects(withMetadataKey:)` on the sync identifier.
  Under `#available(iOS 18)`, `relateWorkoutEffortSample` when `effortScore` is set (hook only).
- Wiring: `TrackerDependencies.swift` gains `health: any HealthWorkoutPublishing`;
  `Apex/AppModel.swift:192-214` builds the adapter (fake under `-apexUITest` and
  `-apexMockHealth <authorized|denied|unavailable>`, flag in `Apex/Mock/MockEnvironment.swift`).
- You tab: `YouRoute.appleHealth` (`Profile/YouServices.swift`), `HealthModel` + `AppleHealthView`
  in `ApexFeatures/Integrations/` on the `CorosModel`/`CorosView` pattern; row after COROS in
  `YouTab.swift:173-182`. **M1 toggle state is device-local** (UserDefaults, like the onboarding
  nudge) because the server `apple` connection row arrives in M0/M2; M2i migrates it once.
  Toggle ON → `requestAuthorization(toShare: [.workoutType()], read: [])`; denied renders
  "Denied — Health › Sources › Apex".
- HELD: `Apex/Apex.entitlements` (+`com.apple.developer.healthkit`), `Apex/Info.plist`
  (+`NSHealthUpdateUsageDescription` only — the share string waits for M2 so the 1.1 review is
  write-only), `project.yml` (`- sdk: HealthKit.framework`, `ApexHealth` on the Apex target,
  `MARKETING_VERSION` 1.1.0), `scripts/ci-guards.sh` (add `HealthKit` to the ApexCore import
  ban). `PrivacyInfo.xcprivacy` unchanged in M1 (writing is not collection).
- Docs: `app-store.md` §1 row and §6 note reworded ("writes workouts to Health; reads nothing");
  `testing-and-ci.md` App Store gate line; `check-deinits.sh` (D-031) for new classes.

Acceptance:
- [ ] `swift test --package-path ios/Packages/ApexCore`: draft mapping vectors, identifier and
      version, nil draft when `startedAt` is missing.
- [ ] `ApexTests/TrackerModelTests` with a `HealthSpy` (the `ActivitySpy` pattern): finish
      publishes one draft with real instants; toggle off publishes nothing; cancel-after-finish
      deletes; offline finish still publishes.
- [ ] `YouSnapshotTests` row + `apple-health` screen; smoke `testYouOnFixtures` with
      `-apexMockHealth authorized` reads "Writing workouts".
- [ ] Device (Shane): a finished workout appears in Health with Apex as source and the right
      type; cancel removes it; a second finish of the same occurrence replaces, not duplicates.
- [ ] Released as 1.1.0 by `testflight.yml` **after** 1.0 is approved.

### M0 — Migration `phaseN_apple_health.sql` (one file for M2 and M3) · Linux · HELD
Claim `N` with `scripts/next-phase.sh` at PR time. Inert until code reads it (phase55 precedent).
- `provider_connections.provider` CHECK → `IN ('coros','apple')`; `+ categories jsonb NOT NULL
  DEFAULT '{}'` (keys allowlisted in the handler — the phase41 posture).
- `provider_activity_imports.mode` CHECK → `('created','filled','skipped')`.
- New `daily_metrics`: `user_id` (FK `auth.users` cascade, inside the `CREATE TABLE` body so
  `account.test.ts` sees it), `date`, `provider`, `sleep_minutes`, `sleep_stages jsonb`,
  `sleep_start`/`sleep_end timestamptz`, `hrv_sdnn_ms numeric`, `resting_hr int`, `steps int`,
  `body_mass_lb numeric`, `sources jsonb`, `updated_at`; PK `(user_id, date, provider)`.
  Service-role only — the phase52 RLS block verbatim.
- `profiles` `+ body_weight_updated_at timestamptz`, `+ body_weight_source text`.
- `notify pgrst, 'reload schema'`; `npm run db:reset-local && npm run db:types` committed (TS
  and Swift generated types); `'daily_metrics'` added to `USER_DATA_TABLES`
  (`api/_lib/handlers/account.ts`) in the same PR so export/delete and `account.test.ts` hold.

Acceptance:
- [ ] `migration-numbering`, `rls-coverage`, `account` tests green; `scripts/db-types.sh --check`
      clean; `prod-schema-check` exit 0 after Shane pastes it.

### M2b — Backend: Health workouts in as provider `apple` · Linux
The phone *is* the provider: activities arrive in the body, the HealthKit anchor is the phone's
watermark, and there is no token (`handleSyncAction` skips `getFreshAccessToken` for `apple`).
Contract — all `POST /api/provider-sync` (JWT; bucket `providerSync` 60/h; `client:'ios'`
required on apple actions except `status` and `disconnect`):
```
{ action:'connect', provider:'apple', client:'ios', timezone,
  categories:{ workoutsWrite?, workoutsRead?, dailyMetrics?, bodyMass?, mealsWrite? } }
  → { ok, apple:{ status:'connected', connectedAt, lastSyncedAt, categories } }     // upsert; auto_sync=false
{ action:'set-categories', provider:'apple', categories:{ …partial } }
  → { ok, categories } | 409 'not-connected'
{ action:'status' } → { coros:{ …unchanged }, apple:{ status, connectedAt, lastSyncedAt, categories } }
{ action:'disconnect', provider:'apple', purgeMetrics?:bool } → { ok, purged:{ dailyMetrics:n } }
{ action:'preview', provider:'apple', client:'ios', timezone, activities:AppleActivity[1..100] }
  → { proposals:[Proposal], skipped:[{ activityId, reason:'own-app'|'duplicate'|'out-of-window'|'already-imported' }] }
{ action:'apply', …as preview, decisions:[{ activityId, action:'fill'|'create'|'skip', targetEventId?, eventDate? }] }
  → { created, filled, skipped, errors }
{ action:'ingest', …as preview }     // unattended: create unmatched, never fill; matched return as `pending`
  → { created, skipped, pending:[Proposal], errors }
AppleActivity = { activityId:<HKWorkout.uuid>, activityType:int, activityName, sourceBundleId, sourceName,
                  startUtc, endUtc, durationSec, distanceMeters?, elevationGainMeters?, avgHr?, maxHr?,
                  calories?, summaryExtras?, streams?:{ hr:[[sec,bpm]] ≤ 2000 } }
```
Idempotency: `activityId` is the ledger PK; every write upserts with the ledger last; own-app and
duplicate activities get `mode:'skipped'` ledger rows so re-sends are no-ops; the phone's anchor
advances only on a 200, so a reinstall re-sends and the ledger converges.

Scope:
- `api/_lib/providers/connection.ts`: `SyncProvider` widened; `connectLocal`, `setCategories`,
  `parseCategories`; `connectionStatus` emits `categories`.
- `api/_lib/handlers/providerSync.ts`: `parseProvider`, the new actions, `status.apple`, the
  client gate.
- `api/_lib/providers/sync.ts`: `loadSyncContext` takes `activities` instead of fetching;
  the `'Synced from COROS'` subtitle becomes per-provider; `startUtc` bounded to
  `[now−30d, now+5min]`; own-app and cross-provider duplicate pre-filter (`startUtc` ±120 s and
  duration ±10 % against `activity_streams.summary`); a `'skip'` decision (rejected for coros);
  `runIngest` exported.
- New `api/_lib/providers/apple/activity.ts`: body parser + `mapActivityType` keyed on the
  **integer** `HKWorkoutActivityType` (pin the table against the SDK header on a Mac). Apple
  must not go through the COROS label mapper: `coros/mapSport.ts` sends "Traditional Strength
  Training" to `outdoor-climbing` via `/trad/`.
- `downsample` moves from `coros/client.ts` to `providers/streams.ts`; `src/lib/db/types.ts`
  `SyncProvider`; `src/components/modal/SyncMetrics.tsx` `PROVIDER_LABELS.apple`.
- Cron untouched: apple rows carry `auto_sync=false`, so `providerCron.ts` never lists them.
  D-051 holds for free (`endLiveActivities` runs inside `writeActivityRecords`).
- Legal and docs (timing is Shane's call; recommended here, once, with text that already covers
  M3): `legal/privacy-v2.md` + `PRIVACY_VERSION` bump (re-acceptance for every user);
  `app-store.md` §1 Health → **Yes**, §4 external-services line, §5 row for guideline 5.1.3,
  the recording script's permission step; `backend-changes.md` W16 section.

Acceptance:
- [ ] `provider-sync.test.ts`: apple connect / set-categories / status / disconnect / client gate.
- [ ] New `apple-activity.test.ts`: parser bounds; the mapper table including the
      "Traditional Strength" trap.
- [ ] `integration/provider-sync.integration.test.ts`: apple fill, create, skip, replay.
- [ ] `provider-cron.test.ts`: apple rows absent from the nightly list.
- [ ] Fixtures: `ios/Fixtures/provider-status.json` (apple block), `provider-preview-apple.json`.

### M2i — iOS: read Health workouts · Mac
Backend contract consumed: M2b (`backend-changes.md` W16). Absent `apple` in `status` = not
connected.

Scope:
- `ApexHealth/HealthWorkoutReader.swift`: `HKAnchoredObjectQueryDescriptor` on `.workoutType()`;
  own source excluded (`NOT predicateForObjects(from: .default())`); HR samples per workout
  (`predicateForObjects(from: workout)`); `enableBackgroundDelivery(.immediate)` +
  `HKObserverQuery` — the observer only enqueues; `WriteQueueDriver` sends.
- ApexCore: `Models/Health.swift` (`HealthWorkoutImport`, payloads, `Downsample.evenly(max:
  2000)`); `WriteQueueStore` `case healthIngest(HealthIngestPayload)` in the `.outbox` lane;
  `Endpoint` (`provider:` on preview / apply / status / disconnect; `connect`, `set-categories`,
  `ingest`); `Integrations.swift` (`ProviderStatusResponse.apple`); `CacheStore` `case
  healthAnchor` (per owner, purged on account switch).
- Flow: read → batch → enqueue `.healthIngest` → persist the anchor **after** enqueue → on
  landing, `pending` proposals show in the COROS confirm sheet through a `ProviderSyncModel`
  extracted from `CorosModel.swift:156-242` (parameterised by provider; `CorosModel` keeps
  OAuth) → confirm → `apply` with the activities re-read from HealthKit by UUID.
- `HealthModel` toggles move to the server (`connect` on first ON, `set-categories` after);
  M1's local flag migrates once, then is deleted.
- HELD: `Info.plist` `+NSHealthShareUsageDescription`; entitlement
  `+com.apple.developer.healthkit.background-delivery`; `PrivacyInfo.xcprivacy`
  `+NSPrivacyCollectedDataTypeHealth`.

Acceptance:
- [ ] ApexCore: payload round-trip, downsample, anchor key, endpoint bodies.
- [ ] `ApexTests`: reader over `FakeHealthStore` — one op per batch; anchor saved after enqueue,
      not before; own-source predicate asserted; toggle off → no query.
      `ProviderSyncModelTests` through `YouTransport`. Snapshots re-recorded.
- [ ] Smoke: `-apexMockHealth authorized` seeds fake workouts → ingest → confirm sheet → toast.
- [ ] Device (Shane): a Watch strength workout fills a planned occurrence with HR streams; a run
      with no plan is created as `apple-<uuid>`; the Apex-written workout from M1 is never
      re-imported.

### M3b — Backend: daily metrics, body weight both ways, coach · Linux
```
POST /api/daily-metrics { provider:'apple', timezone,
  days:[{ date, sleepMinutes?, sleepStages?:{ core, deep, rem, awake }, sleepStart?, sleepEnd?,
          hrvSdnnMs?, restingHr?, steps?, bodyMassLb?, sources? }] (1..62) }
  → { ok, upserted, profileBodyWeightLb? } | 409 'not-connected' (no apple row, or category off) | 400 field-named
GET  /api/daily-metrics?start&end (≤ 400 days; bucket `reads`) → { days }
```
One upsert per row on `(user_id, date, provider)`; absent fields untouched, explicit `null`
clears (HealthKit delivers piecemeal: steps all day, sleep next morning). Sleep is attributed to
the date it ended; the phone owns the day. `bodyMassLb` on the newest date also writes
`profiles.body_weight_lb` + `body_weight_updated_at` + `body_weight_source='apple'` when
`categories.bodyMass` is on. `GET /api/profile` gains `weightUnit`, `bodyWeightLb`,
`bodyWeightUpdatedAt`, `bodyWeightSource`; `PATCH body_weight_lb` stamps `source='user'`.

Scope:
- `api/_lib/handlers/dailyMetrics.ts` + `api/_lib/services/dailyMetrics.ts` (bounds: sleep
  0..1440 min, resting HR 20..250, HRV 0 < x < 1000 ms, steps 0..200000, mass 0 < x < 1500 lb,
  date within `[today−90d, today+1d]`); route in `api/_lib/app.ts`; disconnect purge wired.
- Coach: `PhysiologyInputs.dailyMetrics` (`src/lib/physiology/types.ts`); a fifth parallel fetch
  in `api/_lib/coach/physiology.ts`; `computeSleep` / `computeRestingHr` / `computeSteps` /
  `computeBodyMass` in `compute.ts`; `computeHrv` prefers daily SDNN and never mixes it with
  activity HRV; `describe.ts` adds lines inside the existing `<physiology>` tags, each omitted
  when empty — `prompt.ts` and `context.ts` untouched. `recovery.ts` already tells the coach what
  to do with sleep, HRV and resting HR; M3b is what finally supplies them.
- Mixed-provider load: Apple carries no `trainingLoad`; `computeLoad` counts COROS only (accepted
  for M3; HR-derived load later).

Acceptance:
- [ ] `daily-metrics.test.ts`, `coach-physiology.test.ts`, `physiology.test.ts`,
      `profile.test.ts`, `router.test.ts`, `account.test.ts` green.
- [ ] `eval-analyst` run before merge — prompt text moves and the gate baseline is HELD.
- [ ] Fixtures: `daily-metrics.json`; `profile.json` regenerated.

### M3i — iOS: daily metrics + body weight both ways · Mac
Backend contract consumed: M3b.

Scope:
- `ApexHealth/DailyMetricsReader.swift`: sleepAnalysis (anchored, category), HRV SDNN, resting HR,
  bodyMass (anchored; own source excluded — the loop guard); steps via
  `HKStatisticsCollectionQuery` daily sum (dedups phone + watch).
- ApexCore `Models/DailyMetrics.swift`; `WriteQueueStore` `case dailyMetrics(payload)` with
  pending-tail merge by date (like `.save`); `Endpoint`; `Profile.swift` weight fields.
- `ApexFeatures/Profile/BodyWeightView.swift` (the `HeartRateZonesView` form shape): save →
  `PATCH /api/profile`, then `health.writeBodyMass` when `bodyMass` is on
  (sync id `apex:bodyweight:<iso>`).

Acceptance:
- [ ] ApexCore: day attribution, merge rule, payload encode.
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
   disconnect, status and purge mirror COROS; M1 holds them locally until M2.
4. Apple imports reuse the confirm sheet: matches ask, unmatched create silently (`ingest`).
5. Disconnect keeps imported workouts (COROS parity), with opt-in `purgeMetrics`.
6. No routes (Location stays No). Steps via statistics, not samples. HK UUIDs stay phone-local.
7. Privacy policy bumps once, at M2, with text covering M3 — Shane confirms the bump.
8. Apple carries no training load; `computeLoad` counts COROS only until HR-derived load exists.

## Not verified by the planning pass
HealthKit API signatures and `HKWorkoutActivityType` raw values (from memory — pin against the
SDK header on a Mac in M2b); `get_meals` `updated_at` for a later web-meal catch-up; evals
coverage of the physiology block; the ASC console steps for a Health-reading build.

## Session log
- 2026-10-14 · Mac · Brief drafted from the plan (`~/.claude/plans/lets-make-a-plan-serene-pebble.md`):
  scope, data home and order decided by Shane 2026-10-13; three read-only explorers and two
  design passes (iOS, backend) reconciled. No code.

## Next brief
**M1 — Write finished sessions to Health.** Goal: a tracker finish writes an Apex-branded
`HKWorkout` with the real start and end, the right activity type and sync metadata; cancel
deletes it; a You → Apple Health screen holds the one toggle. Scope: the M1 section above, nothing
from M2. Acceptance: the five M1 boxes. Owns: `ios/Packages/ApexKit/Sources/ApexHealth/` (new),
`ios/Packages/ApexCore/Sources/ApexCore/Health/` (new), `ApexFeatures/Tracker/TrackerModel.swift`,
`ApexFeatures/Tracker/TrackerDependencies.swift`, `ApexFeatures/Integrations/{HealthModel,
AppleHealthView}.swift`, `ApexFeatures/Profile/{YouTab,YouServices,YouModel}.swift`,
`ios/Apex/{AppModel.swift,Mock/MockEnvironment.swift}`, the HELD release surface listed in M1,
`scripts/ci-guards.sh` (one regex token), `docs/ios/{app-store,testing-and-ci,decisions,STATUS}.md`.
Forbidden: `ios/Packages/ApexKit/Package.swift` beyond adding the product; any tracker file the
#417/#419 parity lane owns; `legal/`. Mac session.
Release only after 1.0 is approved.
