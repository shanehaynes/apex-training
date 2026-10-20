# W17 — Voice set logging

**Machine:** both (M1 Linux-able · PR-H and M2 Mac · M3 Shane's device) · **Depends on:** W4
(tracker + write queue), #466 (`Weight`) · **Unblocks:** —
**Status:** M2 in review (PR #484, `feat/w17-voice-logging`, stacked on PR-H #480 and M1) — PR-H #480 held for `shipit`; M1 `feat/w17-voice-parser` in review; brief drafted 2026-10-20 (D-059)
**Owns:** `ios/Packages/ApexCore/Sources/ApexCore/Tracker/Voice/` (new),
`ApexCore/Tracker/TrackerEditor.swift`, `ApexCore/Library/NearMatch.swift`, `ApexCore/Package.swift` (one
`exclude` line), `ios/Packages/ApexCore/Tests/ApexCoreTests/`, `ios/Packages/ApexKit/Sources/ApexSpeech/` (new),
`ios/Packages/ApexKit/Package.swift`, `ApexFeatures/Tracker/{TrackerModel,TrackerModel+Voice,TrackerScreen,TrackerDependencies,VoiceStrip,TrackerPreviews}.swift`,
`ApexFeatures/Profile/YouTab.swift`, `ApexUI/Icons.swift`, `ios/Apex/{AppModel.swift,Mock/MockEnvironment.swift}`,
`ios/ApexTests/`, `ios/ApexUITests/SmokeUITests.swift`, the three held files (`ios/Apex/Info.plist`,
`ios/project.yml`, `scripts/ci-guards.sh`), `docs/ios/*`. · **Forbidden:** `src/`, `vercel.json`,
`ApexFeatures/Tracker/TrackedExerciseView.swift` (the D-054 scroll surface M2 is measured against),
`legal/`, `ios/Fixtures/` (emitter-only), `ios/Apex/PrivacyInfo.xcprivacy`, the entitlements, `ios/Config/`,
`package.json`. Each milestone's Next brief narrows these further.

## Goal
During a live workout the user taps a subtle microphone in the tracker, says "back squat for 5
reps and 225", and that set appears in the workout and autosaves through the write queue.
Recognition is Apple's Speech framework **on the device only**; parsing is deterministic Swift.
No LLM, no tokens, no network — it works in the basement gym the tracker already promises. When
the spoken exercise is unambiguously one of today's exercises the set is logged at once with
**Undo**; a near match, an unknown name and (in v1) an exact library hit not in today's session
**ask first**. The feature ships dark behind a You → Training toggle and a transcript-only voice
journal is how it is measured and tuned until it earns its default.

Out of scope, on purpose: the web app (a Home Screen web app on iOS cannot use speech
recognition at all — WebKit bug 225298 — and `vercel.json` denies the microphone; a later web port
reads this workstream's fixture); cardio rows and climbing pitches; a server-side recognition
fallback (a separate decision, D-060 if ever); Siri / App Intents; relative edits ("add ten") and
corrections ("no, six"); the iOS 26 `SpeechAnalyzer` adapter (M3 candidate); `MARKETING_VERSION`
(bumped at store-submission time in its own held one-liner, never in a W17 PR).

## Order and gates
```
PR0 board (this brief, D-059)
PR-H held plumbing (Mac, shipit; no UI) ─┐
M1 parser + editor primitives (ApexCore) ─┴─▶ M2 tracker UI (Mac, unheld) ─▶ TestFlight, toggle on
                                                    └─▶ M3 dogfood: journal ─▶ fixture PRs ─▶ default-on
```
PR-H ∥ M1 (disjoint files; neither needs the other). M2 after both merge. M3 is a loop of
ApexCore-only PRs driven by Shane's gym sessions, with an exit criterion and a budget. Worktrees:
`scripts/git-new.sh feat/w17-<piece> "W17 <piece>: <files>"`. Mac lanes run `cd ios && xcodegen generate`
in their own worktree and use one simulator id per `xcodebuild` run
(`-destination 'platform=iOS Simulator,id=<udid>'`; two runs on one booted simulator kill each
other's UI tests). The held PR (PR-H) is tiny on purpose: the two usage strings are the only prose
Apple sees, and W16's small held PR (#439, two files) merged within the day.

## Milestones

### PR-H — The held plumbing · Mac · `feat/w17-speech-surface` · HELD (`shipit`)
No behaviour change: no mic, nothing calls `listen` outside tests.

**Design.** A new ApexKit product **`ApexSpeech`** on the `ApexHealth` shape
(`ApexKit/Package.swift:86-94`): ApexCore only, `.swiftLanguageMode(.v6)`, **no**
`defaultIsolation` — audio and recognition callbacks arrive off-main, and
`ios/scripts/check-deinits.sh` pins the count of MainActor-default targets. Files in
`ios/Packages/ApexKit/Sources/ApexSpeech/`:
- `SpeechRecognizing.swift`:
  ```swift
  public enum SpeechAuthorization: Sendable { case unavailable, notDetermined, denied, authorized }
  public enum SpeechAvailability: Sendable, Equatable { case unavailable(reason: String); case available(locale: String) }
  public enum SpeechFailure: Sendable, Equatable {
      case notAuthorized, dictationDisabled, assetsMissing, noSpeech, noInput, serviceFailed, interrupted, cancelled
  }
  public enum SpeechEvent: Sendable, Equatable { case listening; case partial(String); case final([String]); case failed(SpeechFailure) }
  /// Names to bias toward; a custom language model slots in here later (M3).
  public struct SpeechBias: Sendable { public var names: [String] }
  /// One utterance. `events` ends after .final or .failed. Cancelling the consumer aborts
  /// (mic off, no final). `finish()` calls endAudio() and lets the final arrive.
  public struct SpeechUtterance: Sendable { public let events: AsyncStream<SpeechEvent>; public let finish: @Sendable () -> Void }
  public protocol SpeechRecognizing: Sendable {
      func availability() -> SpeechAvailability          // live: isAvailable changes at runtime
      func authorization() -> SpeechAuthorization
      /// Both sheets, Speech then the microphone; a denial of either is `.denied`.
      func requestAuthorization() async -> SpeechAuthorization
      /// At most one utterance at a time; starting another aborts the previous.
      func listen(bias: SpeechBias) -> SpeechUtterance
  }
  ```
- `NoSpeechRecognizer` (`.unavailable`) — the services default and previews.
- `SFSpeechRecognizerAdapter: SpeechRecognizing, @unchecked Sendable` — `let recognizer` plus a
  lock-guarded `current: Utterance?` (`NSLock` + `withLock`, the `FakeHealthStore` / `HeldClock`
  idiom; `Mutex` is iOS 18). Locale: the first preferred language with an `en` prefix, else
  `en-US` (`init(locale:)` would silently fall back to the keyboard's dictation language).
  Availability: a recognizer exists for that locale **and** `supportsOnDeviceRecognition`; never
  gate on `isAvailable` alone (the network-era signal). Runtime task errors carry the real
  failures and are mapped: `kLSRErrorDomain` 201 → `.dictationDisabled`, 102 → `.assetsMissing`;
  `kAFAssistantErrorDomain` 1110 → `.noSpeech`, 1101/1107 → `.serviceFailed`, 1700 →
  `.notAuthorized`. A private `Utterance: @unchecked Sendable` owns the `AVAudioEngine`, the
  request, the task and a `running | finishing | ended` state behind the lock; `listen` does
  `AsyncStream.makeStream()`, `onTermination → abort()`, swaps `current`. Per tap, in order:
  `setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .allowBluetoothA2DP, .defaultToSpeaker])`
  (no HFP in v1 — it gives HFP priority and degrades music; `.default` mode is the gym A/B knob)
  → `setActive(true)` → guard the input format has `sampleRate > 0 && channelCount > 0` else
  `.failed(.noInput)` → install the tap (buffers only appended) → `prepare()` → `start()` → yield
  `.listening` → start the task with `requiresOnDeviceRecognition = true`,
  `shouldReportPartialResults = true`, `addsPunctuation = false`, `contextualStrings = bias.names`,
  via `recognitionTask(with:delegate:)` for `speechRecognitionDidDetectSpeech`. Teardown on every
  exit: `task.cancel()`/finish → `removeTap` → `engine.stop()` →
  `setActive(false, options: .notifyOthersOnDeactivation)` (deactivating with running I/O fails
  with `IsBusy`). Observe interruption began, route disconnected and engine configuration change
  → `.failed(.interrupted)` (never auto-resume); `availabilityDidChange(false)` aborts a live
  listen. Never pre-warm the engine or the session (activation starts ducking and the orange
  indicator); create the recognizer when the tracker opens.
- `FakeSpeechRecognizer` — `init(authorization:, availability:, script: [String], grantOnRequest: Bool = true)`
  with two drive modes: scripted (each `listen` yields the next utterance word by word as partials,
  then `.final([utterance])`) and step-wise (`emit(.partial(_))`, `emitFinal()`, `fail(_)`) for
  end-of-utterance unit tests over `TestClock`. Records `requestCount` and `biases: [[String]]`.

Scope (unheld files in the same PR):
- `TrackerServices.speech: any SpeechRecognizing = NoSpeechRecognizer()` after `health`
  (`TrackerDependencies.swift:16-33`).
- `AppModel.ensureQueue` builds it beside `health` (`AppModel.swift:244-245`);
  `AppModel.speechRecognizer()` mirrors `healthServices` (:751-759): `-apexUITest` or
  `-apexMockSpeech` → `MockEnvironment.speech()`; otherwise `#if targetEnvironment(simulator)` →
  the Fake unless `-apexRealSpeech` (Apple's Speech sample does not run in the simulator);
  device → the adapter.
- `MockEnvironment.swift`: flag doc after the `-apexMockHealth` entry; `static func speech()`
  after `health`: `-apexMockSpeech "<utt>;<utt>"` scripts utterances in order; the literals
  `denied` and `unavailable` set those states. (`fix/ios-mock-raw-interpolation` edits this file
  — adjacent hunks, merge by hand.)
- `ios/ApexTests/SpeechAdapterTests.swift` over the Fake.
- HELD: `ios/Apex/Info.plist` after line 88 —
  ```xml
  	<!-- W17: voice set logging (D-059). Recognition runs on the device only
  	     (requiresOnDeviceRecognition); nothing said leaves the phone. Both
  	     sheets show on the first mic tap in the tracker, never at launch. -->
  	<key>NSSpeechRecognitionUsageDescription</key>
  	<string>Apex turns what you say — “bench 225 for 5” — into a logged set using your iPhone’s on-device speech recognition. Apex only asks for on-device recognition and never uploads audio.</string>
  	<key>NSMicrophoneUsageDescription</key>
  	<string>Apex listens after you tap the mic button in the tracker, so a set can be logged without touching the keyboard.</string>
  ```
  `ios/project.yml` — Apex target: `- package: ApexKit` / `product: ApexSpeech`, and
  `- sdk: Speech.framework` / `- sdk: AVFAudio.framework` **only if the build does not link
  without them** (say which in the PR body); ApexTests: `- package: ApexKit` /
  `product: ApexSpeech` / `link: false`. `scripts/ci-guards.sh:62` — extend the ApexCore import
  ban with `|Speech|AVFoundation|AVFAudio`. `PrivacyInfo.xcprivacy`, the entitlements and
  `ios/Config/` are **not** touched (Speech and the microphone are not required-reason APIs;
  on-device processing is not "collected").
- Docs: `app-store.md` §1 row
  `| User Content → Audio Data | No | | | W17 logs sets by voice with on-device speech recognition (D-059); audio is processed on the device only, never recorded, stored or sent; the logged set is the fitness data already declared |`;
  `testing-and-ci.md`'s gate list gains the two usage strings.

Acceptance:
- [ ] `ios` job green; `ios/scripts/check-deinits.sh` clean; every snapshot byte-identical; no mic exists.
- [ ] `SpeechAdapterTests` over the Fake: `.listening` then partials then `.final`; cancelling the consumer ends the stream; `finish()` yields the final; `requestCount == 1` after one `requestAuthorization()`; `biases[0]` equals the names passed to `listen(bias:)`.
- [ ] SDK pins answered in the PR body (device and simulator): `supportsOnDeviceRecognition` on the 15 Pro; `requiresOnDeviceRecognition` with `contextualStrings`; `addsPunctuation` honoured on-device; `AVAudioApplication.requestRecordPermission` on iOS 17; A2DP route keeps AirPods music while listening; `.notifyOthersOnDeactivation` un-ducks; whether the `sdk:` lines are needed; the permission sheet wording. Device-only pins without a device → NOT VERIFIED, not guessed.
- [ ] The usage strings, project.yml, ci-guards and docs rows as above; `MARKETING_VERSION` untouched.

### M1 — Parser, resolver, storage formatter, editor primitives · ApexCore · Linux · `feat/w17-voice-parser`
New directory `ios/Packages/ApexCore/Sources/ApexCore/Tracker/Voice/`, Foundation only (the
ci-guards import ban). A manual tokenizer plus rule functions, no regex beyond token
classification, every table a literal — so a later web port is mechanical and the fixture is
the contract. Build it red-to-green: write the fixture and its test first.

**Types** (`SpokenSet.swift`):
```swift
public struct SpokenWeight: Codable, Equatable, Sendable { var value: Double?; var unit: Weight.Unit?; var bodyweight: Bool; var sign: Int } // sign −1/0/+1 for BW±
public struct SpokenValues: Codable, Equatable, Sendable { var weight: SpokenWeight?; var reps: Int?; var durationSeconds: Int?; var rpe: Double?; var isWarmup: Bool }
public enum SpokenIntent: Equatable, Sendable { case log(sets: Int, values: SpokenValues); case `repeat` }
public enum SpokenExercise: Equatable, Sendable {
    case current
    case resolved(scope: Scope, id: String, name: String, match: Match)      // Scope: session | library; Match: exact | contained
    case needsConfirmation(phrase: String, candidates: [Candidate])          // Candidate: scope, id, name, match (exact|contained|near), distance
    case unresolved(phrase: String)
}
public enum SpokenProblem: String, Codable { case duplicateWeight, duplicateReps, duplicateDuration, setsOutOfRange, tooManyNumbers, ambiguousNumbers, repsNotInteger, rpeOutOfRange, barePair }
public struct SpokenParse: Equatable { status: ok|empty|invalid; transcript; chosen: Int; intent: SpokenIntent?; exercise: SpokenExercise; ignored: [String]; problems: [SpokenProblem]; score: Int }
public struct VoiceContext { unit: Weight.Unit?; session: [VoiceSessionExercise]; currentExerciseId: String?; library: [ExerciseDefinition] }
public struct VoiceSessionExercise { id; section; name; definitionId: String?; fields: [SetField] }
```
`Weight.Unit` gains `Codable` through an extension in `SpokenSet.swift` (same module; `Weight.swift` untouched).
`VoiceStorage.text(for:unit:)` — the one formatter: weight bare `"225"` when no unit was spoken
(the profile unit is implied; iOS typed-entry parity, `setToRow` sends what was typed), `"225 lb"`
/ `"62.5 kg"` when one was, `"BW"`, `"BW+25"`, `"BW+10 kg"`, `"BW-10"`; reps `"5"`; duration
`DurationBuffer.formatSeconds` (`"45s"`, `"1:30"`, `"2:00"`); RPE snapped to halves within 1–10
(out of range → `rpeOutOfRange`, dropped). Every problem except `rpeOutOfRange` and `barePair`
makes the status `invalid`.

**Files**: `VoiceTokens.swift` (`tokenize`), `VoiceNumbers.swift` (`readNumber`, `readDuration`),
`VoiceExercise.swift` (`voiceWords`, `voiceKey`, `resolveExercisePhrase`), `VoiceSlots.swift`
(`extractPhrase`, `assignSlots`, `maxSets = 10`, `bareWeightFloor = 50`), `VoiceParser.swift`
(`parse(_:context:)`, `parse(alternatives:context:)`, `score`), `VoiceStorage.swift`.
The resolver reuses `NearMatch.distance` and the internal `NearMatch.budget` (same module, no
visibility change) so session names get the picker's typo budget.

Pipeline: tokenize → extractPhrase → resolveExercisePhrase (or `.current`) → hint = the target
session exercise's `fields` (the caller passes the current exercise's fields for `.current`; empty
for library/unresolved) → assignSlots → intent → score. An empty hint falls through to R12's
N > 50 rule, so "front squat 225" is a weight, never 225 reps. The hint only disambiguates bare
numbers and clocks: a spoken field the exercise does not plan is still written — its column appears, as
the "+ weight" chip's does (`TrackerEditor.inputFields` derives columns from any non-empty value).

**Tokenizer.** Lowercase; `×`→` x `, `@`→` at `, `+`→` plus `, `#`→` lb `; **`x` between digits
splits** (`5x5`, `225x5`); apostrophes deleted; hyphens → spaces; a comma between digits follows
`Weight`'s rule, any other comma separates; split on whitespace; strip trailing `.!?`; digits →
`number`; `d:dd` / `h:mm:ss` → `clock`; glued units split (`225lbs`, `45s`, `2m`, `100k`), single
letters count as units only when glued. **Keyword vocabulary** — a `word` token that is never part
of an exercise phrase and ends the leading phrase run: weight units `lb lbs pound pounds kg kgs
kilo kilos kilogram kilograms`; duration units `second seconds sec secs minute minutes min mins`;
`rep reps set sets of`; `rpe`; `bw bodyweight body weight plus minus`; the connectives `at for x by
times and`; `warmup` and the bigram `warm up` (consumed together — `up` alone is not a keyword, so
"chin up" and "pull ups" stay phrases); the repeat words `again same repeat one more another`; the
fillers `okay ok um uh did log just i the please`; and every number word.

**Number words.** (1) English 0–9999: `a|an` before `hundred|thousand|half|minute` = 1; tens may
take one unit word; `hundred` multiplies the open group; `thousand` closes it; `and` is skipped
only right after `hundred`; a units word followed by a tens word stops. (2) Gym shorthand: one
word valued 1–9 followed by a tens group (tens[+unit] | teen | `oh|zero`+unit) → d×100 + group
(`two twenty five`→225, `one thirty five`→135, `three fifteen`→315, `two oh five`→205).
(3) Fractions: `point d…`, `and a half` (+.5), `and a quarter` (+.25). (4) **Never numbers:**
`for`, `to`, `too`, `won`, `ate` — homophones are settled by alternative ranking, never guessed.
Digits never merge with neighbours. (5) **Clock as a number:** dictation may format "two twenty
five" as `2:25`; a `d:dd` clock (d 1–9, dd < 60) is the number d×100+dd **unless** the hint
contains `.duration`, in which case it is a duration; `h:mm:ss` is always a duration.
(6) `readDuration`: clock; `N minutes [M [seconds]]`; `N seconds`; `a minute`, `half a minute`,
`a minute thirty`, `a minute and a half`; fractional minutes.

**Slot rules** (in order; first hit wins per number):

| # | pattern | decision | example |
|---|---|---|---|
| R1 | number + weight unit | weight, unit kept | `225 pounds`, `225 lbs` |
| R2 | number + `rep(s)`, or `rep(s)` + number | reps | `5 reps` |
| R3 | number + `set(s)`; `set(s) of` + number | sets; the `of` number is reps | `3 sets of 5` |
| R4 | `rpe` adjacent to a number (digits or words) | rpe | `rpe 8`, `rpe eight` |
| R5 | number + duration unit, clock-as-duration, `a minute…` | duration | `45 seconds`, `plank 1:30` |
| R6 | `bodyweight`/`body weight`/`bw` [`plus`/`minus` N [unit]] | BW forms | |
| R7 | `at` + number: weight empty → weight; else ≤10 → rpe; else `tooManyNumbers` | `5 at 225 at 8` | |
| R8 | pair joined by `for`/`at`/`x`/`by`/`times`, one side already marked | the other side takes the complementary slot | `5 reps for 225` → W225 |
| R9 | unmarked `A for B` | A weight, B reps | `225 for 5`, `2:25 for 5` |
| R10 | unmarked `A at B` | A reps, B weight | `5 at 225`, `five at 225` |
| R11 | unmarked `A x B` (`by`, `times`) | A≤10 and B≤30 → sets×reps; else reps=min, weight=max; a third item takes the next of [sets, reps, weight] | `5x5`; `225x5`; `12 by 20` |
| R12 | lone bare number | hint `[duration]` → duration; hint has reps but not weight → reps; hint has weight but not reps → weight; otherwise (both, or an empty hint) N > 50 → weight, else reps | `plank 60`; `bench 225`; `bench 5`; `front squat 225` → W225 |
| R13 | bare pair A B (no connective, or `and`/comma) | exactly one > 50 → weight; both ≤ 50 → A reps, B weight + `barePair`; both > 50 → `ambiguousNumbers` | `5 225`; `10 20`; `225 185` |
| R14 | a third unmarked number, or a slot filled twice | `tooManyNumbers` / `duplicate…` → invalid | |
| R15 | `warm up`/`warmup` anywhere | isWarmup | |
| R16 | `again`/`same again`/`same`/`repeat`/`one more`/`another one` with no numbers | intent `repeat` | |
| R17 | sets absent → 1; outside 1–10 → `setsOutOfRange` | | `15 sets of 5` |

A reps slot that receives a non-integer value (`five and a half reps`, `7.5 reps`) raises
`repsNotInteger` (invalid).

`extractPhrase`: the leading run of `word` tokens up to the first number/clock/keyword, fillers
(`okay um did log just i the please`) and a trailing connective stripped; else the trailing run
after the last slot with a leading `on/of/for/the` stripped. Unconsumed words → `ignored`, never
fatal. A phrase with no values → `empty`.

**Exercise resolution.** `voiceWords`: split on non-alphanumerics, expand `wordShorthand`
(`db→dumbbell, bb→barbell, kb→kettlebell, ohp→overhead press, rdl(s)→romanian deadlift(s), dl→deadlift, sldl→stiff leg deadlift, chin(s)→chin up(s)`),
singularise per word (`ies→y`; drop a final `s` when length > 3 and not `ss`). `voiceKey` = words
joined, singularised once more. Each candidate gets two keys: the full name, and the name with a
parenthetical removed. Tiers, stop at the first that yields: **1 exact-session** (key equality
over session names + their definition's canonical name and aliases; one → `resolved(exact)`,
several → confirm) · **2 contained-session** (every phrase word ∈ candidate words; one →
`resolved(contained)`, auto-applied — the target is already in today's session and its
`definitionId` is fixed; several → confirm) · **3 near-session** (`NearMatch.distance` within the
picker's budget → confirm, by distance then session order) · **4 exact-library** (over
unarchived, **set-tracked** definitions only — category neither `cardio` nor `climbing`, because
`applySpoken` refuses those and a confirm → add → apply flow would otherwise add an empty
unsupported exercise; one → `resolved(scope: library)`, which the UI treats as **confirm in v1**;
several → confirm) · **5 contained-library,
near-library** (same filter; → confirm, ≤ 3) · **6 unresolved**. No phrase → `.current`.

**Scoring.** `parse(alternatives:)` keeps the best score, ties keep engine order. ok +100 / empty
0 / invalid −100; per value +10, warm-up +2, sets>1 +2; repeat +20; resolved +30, current +20,
confirm +5, unresolved −10; −5 per ignored token; −3 per problem; reps > 50 −20, weight >
1500 lb / 700 kg −20, duration > 3600 s −10.

**Editor primitives** (`TrackerEditor.swift`, additive, Linux-tested):
- `clearShadow(at:) -> Bool` — shadow = nil, **not** dirty (`commitShadow(at:fields:)` always
  dirties and commits, so it is not this).
- `applySpoken(_ intent: SpokenIntent, section:, exerciseId:, unit:) -> VoiceApplied?` — target =
  the first set with no actuals (a ghost-only row counts) else `addExtraSet`; `clearShadow` then
  `setValue` per spoken field via `VoiceStorage`, `setWarmup`, `setRpe`; `repeat` copies the last
  set with actuals; `sets > 1` spans the next empty planned rows then extras. Returns
  `VoiceApplied { keys: [SetKey], previous: [TrackedSet], kind: planned|extra|addedExercise(id) }`.
  Nil for cardio, climbing, or an unknown exercise.
- `revert(_ applied: VoiceApplied)` — deterministic: restore each `previous` verbatim (ghost
  back); if `previous.hasAnyActual || previous.isLogged` → `dirtySets.insert(key)` (the old row is
  re-sent); else → `dirtySets.remove(key)` and `removedSets.append(key)` (never both). Correct
  whether the voice save was flushed or not: the queue merges a later delete over an unsent upsert
  (`WriteQueue.swift:93-111`, `TrackerRows.swift:237-246`) and the server's delete of a missing
  row is a no-op (`workoutSessions.ts:385-394`).
- `currentExercise(lastLogged: SetKey?) -> (section, id)?` — the exercise of the last logged
  key, else the first set-tracked exercise with a set that has no actuals and is not logged.
- **Replay fix:** `apply(_:)` (`TrackerEditor.swift:419-428`) removes any located row for a
  `removedSets` key, planned or extra — a planned-row Undo would make that row vanish on an
  offline relaunch. It must reset a located **non-extra** row to planned-empty (clear actuals,
  `isLogged`, `rpe`, `isWarmup`; keep `planned`/`resolvedPlannedWeight`) instead of removing it.

**Fixture** — `ios/Packages/ApexCore/Tests/ApexCoreTests/Fixtures/voice-cases.json`, hand-authored
(so not under `ios/Fixtures/`, which is emitter-only), read via `TestFixtures.local(_:)` beside
`directory` (`TestSupport.swift:10`). Add `exclude: ["Fixtures"]` to the `ApexCoreTests` target in
`ios/Packages/ApexCore/Package.swift` so SwiftPM does not warn about an unhandled file (path reads
keep working). Schema: `version`; `contexts` (`unit`, `currentExerciseId`,
`session [{id, section, name, definitionId?, fields}]`, `library [{id, canonicalName, aliases?, archivedAt?}]`);
`cases [{ id, name, source: "authored" | "journal:<yyyy-mm-dd>", rules, context, input: [String], expect: { status, chosen, intent, exercise, ignored, problems }, storage: {weight?, reps?, duration?, rpe?} }]`
with `expect.intent.values` typed (`SpokenValues`). Context `upper` (lb, current `bench`):
session bench=Bench Press, squat=Back Squat, pullups=Weighted Pull-Ups, plank=Plank [duration] (every other session exercise logs [weight, reps]),
hammer=Hammer Curl (alias Hammer Curls), dbcurl=Dumbbell Curl; library adds Front Squat, Romanian
Deadlift (alias Stiff-Leg Deadlift), Overhead Press, Ring Dips, Lat Pulldown, Lat Pulldown (Close
Grip), Incline Press (archived), Easy Run (cardio). `kg` = same with unit kg; `nocurrent` =
currentExerciseId null.
Notation: W225 = weight 225 no unit (storage `"225"`); W"105 kg" = unit spoken; D = seconds.

| id | input | values | exercise | note |
|---|---|---|---|---|
| 01 | back squat for 5 reps and 225 | W225 R5 | session squat exact | R2 R12 |
| 02 | bench 5 at 225 | R5 W225 | session bench contained | R10 |
| 03 | 225 for 5 | W225 R5 | current | R9 |
| 04 | five at two twenty five | R5 W225 | current | words |
| 05 | one thirty five for eight | W135 R8 | current | |
| 06 | a hundred and five kilos for three | W"105 kg" R3 | current | R1 |
| 07 | two oh five by five | W205 R5 | current | R11 |
| 08 | 3 x 5 at 225 | sets3 R5 W225 | current | R11 R7 |
| 09 | 3 sets of 5 at 225 | sets3 R5 W225 | current | R3 |
| 10 | 225 x 5 | W225 R5 | current | R11 |
| 11 | 12 by 20 | R12 W20 | current | R11 |
| 12 | 5 x 5 | sets5 R5 | current | R11 |
| 13 | squats 5 reps 225 pounds | R5 W"225 lb" | session squat contained | plural |
| 14 | 100 for 5 (kg ctx) | W100 R5 | current | storage "100" |
| 15 | sixty two and a half kilos for eight (kg) | W"62.5 kg" R8 | current | fraction |
| 16 | 5 at 225 rpe 8 | R5 W225 rpe8 | current | R4 |
| 17 | 5 at 225 at eight and a half | R5 W225 rpe8.5 | current | R7 |
| 18 | warm up 5 at 135 | warm R5 W135 | current | R15 |
| 19 | pull ups bodyweight for 8 | BW R8 | session pullups contained | R6 |
| 20 | weighted pull-ups bodyweight plus 25 for 5 | BW+25 R5 | session pullups exact | hyphen |
| 21 | pull ups body weight plus 10 kilos for 6 | BW+10 kg R6 | session pullups contained | |
| 22 | plank 45 seconds | D45 | session plank exact | R5 |
| 23 | plank for a minute thirty | D90 | session plank exact | |
| 24 | plank 60 | D60 | session plank exact | R12 hint |
| 25 | 1:30 plank | D90 | session plank exact | clock → duration (hint) |
| 26 | again | repeat | current | R16 |
| 27 | squat again | repeat | session squat contained | |
| 28 | hammer curls 10 at 30 | R10 W30 | session hammer exact | alias |
| 29 | curls 10 at 30 | R10 W30 | confirm [session:hammer, session:dbcurl] | |
| 30 | back squad 5 at 225 | R5 W225 | confirm [session:squat] near | |
| 31 | romanian deadlift 8 at 185 | R8 W185 | library exact (UI confirms) | |
| 32 | RDLs 8 at 185 | R8 W185 | library exact | shorthand |
| 33 | ohp 5 at 95 | R5 W95 | library exact | |
| 34 | dips 8 | R8 | confirm [library:ring-dips] | R12 |
| 35 | lat pulldown 10 at 120 | R10 W120 | confirm [lat-pulldown, lat-pulldown-close] | parenthetical |
| 36 | incline press 5 at 185 | R5 W185 | unresolved | archived excluded |
| 37 | for 5 at 225 | R5 W225 | current | "for" never 4 |
| 38 | 5 reps 225 pounds 100 kilos | — | current | invalid duplicateWeight |
| 39 | 15 sets of 5 at 225 | — | current | invalid setsOutOfRange |
| 40 | 225 185 | — | current | invalid ambiguousNumbers |
| 41 | 10 20 | R10 W20 | current | ok, barePair |
| 42 | okay um | — | current | empty |
| 43 | ["for at 225", "5 at 225"] | R5 W225 | current | chosen 1 |
| 44 | ["bench 5 at 225", "bench 5 at 2 25"] | R5 W225 | session bench | chosen 0 |
| 45 | bench press | — | session bench exact | empty |
| 46 | 5 at 225 (nocurrent) | R5 W225 | current | UI decides |
| 47 | bench 2:25 for 5 | W225 R5 | session bench contained | clock as number |
| 48 | 1:35 for 8 | W135 R8 | current | clock as number |
| 49 | five at 225 | R5 W225 | current | mixed words/digits |
| 50 | 225 lbs for 5 | W"225 lb" R5 | current | R1 R8 |
| 51 | 5x5 | sets5 R5 | current | glued x |
| 52 | 225x5 | W225 R5 | current | glued x |
| 53 | 5 at 225 rpe eight | R5 W225 rpe8 | current | R4 words |
| 54 | 5 reps 8 reps | — | current | invalid duplicateReps |
| 55 | plank 30 seconds 45 seconds | — | session plank exact | invalid duplicateDuration |
| 56 | 5 at 225 at 12 | — | current | invalid tooManyNumbers (R7) |
| 57 | 5 at 225 rpe 12 | R5 W225 | current | ok, rpe dropped, problems [rpeOutOfRange] |
| 58 | five and a half reps | — | current | invalid repsNotInteger |
| 59 | easy run 20 minutes | D1200 | unresolved "easy run" | cardio definition excluded from the library tiers |

Acceptance:
- [ ] `swift test --package-path ios/Packages/ApexCore` green on Linux CI and a Mac; `npm run agent:check` green (ApexCore imports clean).
- [ ] `VoiceFixtureTests`: every case passes, failure messages name the case id; `XCTAssertGreaterThanOrEqual(cases.count, N)` with N committed (the only-grows ratchet); every rule R1–R17, every exercise tier and every `SpokenProblem` appears in ≥ 1 case; every case has a `source`.
- [ ] `VoiceStorageTests`: each case's `storage` map matches the formatter; `for|to|too|won|ate` never read as numbers; clock-as-number vs clock-as-duration by hint.
- [ ] `VoiceTokensTests`, `VoiceNumbersTests`, `VoiceExerciseTests` (keys, tiers in isolation, archived excluded, parenthetical, ordering, no phrase → current), `VoiceScoreTests` (ok > empty > invalid; resolved > current > confirm > unresolved; ties keep index).
- [ ] `TrackerEditorTests`: `clearShadow` leaves the key clean; `applySpoken` fills the first empty planned set and clears its ghost, else adds an extra, spans `sets: 3`, copies the last set on `repeat`, returns nil for cardio/climbing; `revert` of a planned row with prior actuals re-dirties, of an empty prior row records a removal and never both; `currentExercise` fallback order; **replay of a removed planned key keeps the row** (reset, not removed).
- [ ] `NearMatchTests`: session names get the picker's budget.
- [ ] Opt-in perf (`APEX_PERF=1`): 1,000 parses × 5 alternatives over `upper` < 1 s.
- [ ] Reviewer report under `## Review`; Session log line below; STATUS recent line.

### M2 — The tracker · Mac · `feat/w17-voice-logging` · unheld · after PR-H and M1
**State and logic** (`TrackerModel.swift` holds the stored state below and relaxes `restCommitted`
and `scheduleSave` from `private` to internal; `TrackerModel+Voice.swift` is a same-module extension
holding the methods only — Swift extensions cannot add stored properties):
- `public private(set) var voice: VoiceLogState = .idle` on `TrackerModel` (value-typed, like
  `rest`/`gate`/`summary` — no child model, no `weak var` back-reference):
  `idle | requesting | activating | listening(partial: String, heardSpeech: Bool) | finishing | applied(VoiceApplied, label: String) | confirming(SpokenValues, sets: Int, candidates: [Candidate]) | unresolved(phrase, values) | failed(SpeechFailure | reason: String) | denied | unavailable`;
  private `listenTask`, `undoTask`, `lastLoggedKey: SetKey?` beside `timerTask`. `VoiceStrip` is
  a pure view over the state (snapshots need no model).
- `showsVoice` = toggle on ∧ `services.speech.availability()` is `.available` ∧ `!isFinished`;
  disabled under the finish gate or the summary. Tap dismisses the keyboard, then: authorization
  (both sheets on the first tap, never at launch) → `listen(bias:)` → consume events.
- `bias.names`: session exercise names (parentheticals split off), then library canonical names
  and aliases, deduped, ≤ 100 strings, plus `RPE`. No common words (Apple's docs want phrases not
  in the system vocabulary).
- **End-of-utterance policy in the model over `services.clock`** (testable with `TestClock`):
  `listening(heardSpeech: false)` → 5 s → `failed(.noSpeech)`; each partial resets the silence
  timer; the window is **1.0 s** when the partial already parses `ok` with two values, **2.0 s**
  when it ends in a connective (`for at x by times of and plus minus`) or is a phrase with no
  values, else **1.5 s**; window elapsed, 8 s total, or a second tap → `finishing`:
  `utterance.finish()`, deadline 1.5 s for the final, else parse the last partial. Background,
  gate change, interruption or availability loss → cancel, nothing applied.
- On the final alternatives: `VoiceParser.parse(alternatives:context:)` with `voiceContext()`
  (session set-tracked exercises with `inputFields`, the current exercise's fields as the
  `.current` hint, definitions, profile unit). Then: `resolved(scope: session)` with values →
  `editor.applySpoken` → `restCommitted` per key (reps/duration start rest, as typing does),
  `loggedSetCount += keys.count` (haptic), `lastLoggedKey`, one `scheduleSave()` → `.applied`;
  `.current` with a current exercise → apply; `.current` without one → `.confirming` over the
  session's set-tracked exercises (≤ 4); `resolved(scope: library)` → `.confirming` with that one
  candidate (v1 policy; tapping adds the exercise then applies on set 1, Undo removes both);
  `needsConfirmation` → `.confirming` (values kept, applied on tap); `unresolved` → `.unresolved`
  (Pick… opens `ExercisePickerSheet(initialQuery:)`); `empty`/`invalid` →
  `.failed("Didn't catch a set — try 'bench 225 for 5'")`.
- `undoSpoken()` → `editor.revert`, then `rest = restBefore` — the `RestTimer` value captured just
  before the apply (a value type, so the snapshot restores the active timer *and* the
  committed-row bookkeeping: a rest the apply started stops, a rest that was running before
  resumes, and `startedRows` no longer holds the reverted rows, so logging the same row again
  starts its rest; `skipRest()` alone would leave the row in `startedRows`) → `restChanged()`,
  one `scheduleSave()`. The `.applied` state carries `restBefore` beside `VoiceApplied`. The
  Undo offer ends on the next logged set (voice or any typed edit to an applied key), the next
  mic tap, or **15 s**; it never auto-dismisses while VoiceOver is running.
- Journal: `VoiceJournal` (ApexCore struct + a file-backed store in ApexPersistence, ring of ≤ 200
  entries): timestamp, build, end reason, alternatives, chosen index, parse summary, action
  (applied / confirming / unresolved / failed), undone-within-window, `tapToListening`,
  `lastPartialToFinal`, `finalToApplied`, thermal state, audio route. **Never audio.** Written on
  every utterance; exported as JSON from You → Training ("Share voice log", "Clear voice log").

**UI** (`TrackerScreen.swift`, new `VoiceStrip.swift`, `Profile/YouTab.swift`):
- Mic in `TrackerHeader` between the `Spacer` and the Finish branch: 44 pt, new `ApexIcon.mic`,
  `textSecondary` at rest, accent with a pulsing dot while listening (static under Reduce
  Motion), identifier `tracker.voice`, label "Log a set by voice", `accessibilityValue` per state.
- `VoiceStrip` beside `SyncStatusStrip`, same chrome: listening → "Listening…" + live partial in
  mono (`tracker.voice.transcript`, `.accessibilityHidden(true)`; strip `.updatesFrequently`);
  applied → "Logged Bench Press · 225 lb × 5" + **Undo** (`tracker.voice.applied`,
  `tracker.voice.undo`); confirming → "Did you mean" chips (`tracker.voice.chip.<id>`) + "Pick…"
  (`tracker.voice.pick`); unresolved → "No exercise named …" + Pick… + Try again
  (`tracker.voice.retry`); denied, dictation-disabled, assets-missing → a Settings line
  (`tracker.voice.settings`, `openSettingsURLString`); failed → reason + Try again. On applied /
  confirming / failed post `AccessibilityNotification.Announcement`. Haptics: light impact on
  listen start, success on applied (via `loggedSetCount`), warning on confirming, error on failed.
- You → Training: toggle "Log sets by voice" (`you.toggle.voice`, `apex.tracker.voice`, default
  off), "Share voice log", "Clear voice log".
- Snapshots at default and `-axxxl`: `tracker-voice-listening|applied|chips|denied|unresolved`,
  `you-training-voice`.

Acceptance:
- [x] `VoiceLoggingTests` (over `VoiceSupport.make(…)` with `speech:` injected — a new file, since `TrackerModelTests.swift` is claimed by another lane): first empty planned set filled and ghost cleared (`focusSet` then returns false); extra when none empty; `sets: 3` planned then extra; `repeat`; library hit → `.confirming`, tap adds + logs, Undo removes both; nil/`.failed` for cardio, pitch, finished; `loggedSetCount` +1 per utterance; save body carries `"actual_weight":"225"` bare and `"100 kg"` when spoken; rest starts on reps; undo restores the rest state captured before the apply (a rest it started stops, a rest that was already running resumes, and re-logging the reverted row starts its rest again); undo before the flush sends nothing for the key, after the flush sends a delete; Undo ends on a typed edit to the key, the next apply, the next mic tap, 15 s.
- [x] End-of-utterance tests over `TestClock` and the step-wise Fake: 5 s no-speech; 1.0 / 1.5 / 2.0 s windows; 8 s cap; second tap; final deadline falls back to the last partial; background/gate/interruption cancel with nothing applied; `finalToApplied` ≤ 100 ms.
- [x] `VoiceLogStateTests`: denied; unavailable → no mic; dictation-disabled and assets-missing → Settings line; partials → transcript; exact → `.applied`; near → `.confirming` keeping values; unresolved; empty/invalid → `.failed`; `.current` with no current → `.confirming` ≤ 4; `biases[0]` names-first, ≤ 100, no common words.
- [x] `VoiceJournalTests`: ring ≤ 200, fields present, no audio bytes, JSON export round-trips.
- [x] Mic shown only when toggle ∧ available ∧ `!isFinished`; `ApexIcon.mic` passes the every-case design test; `VoiceStrip` identifiers as listed; snapshots recorded on a Mac.
- [x] `ApexUITests.testVoiceLoggingOnFixtures` (the `testTrackerOnFixtures` shape): `["-apexUITest","-apexMockClient","-apexMockSpeech","Fixture Press 115 for 4;fixture prss 120 for 3"]` ("prss", not "pres": M1's plural rule reads "pres" as "press" and auto-applies it as a contained match, so the near-miss leg needs a spelling the resolver can only near-match). Green under `-retry-tests-on-failure -test-iterations 2` on the first try (2026-10-20, iPhone 17 / iOS 26.5). The audit is `performAccessibilityAudit` with a handler that fails on any issue whose element is a `tracker.voice*` identifier and prints the rest: two pre-existing "Potentially inaccessible text" issues elsewhere on the tracker were printed, none on the voice elements with the toggle on (`MockEnvironment.speech()` writes `apex.tracker.voice` true on every launch and false for the `off` literal, so legs never leak into each other) → Start → `tracker.voice` → `tracker.voice.applied` → set-1 weight reads 115 → `tracker.voice.undo` → empty → mic → chip → 120; `-apexMockSpeech denied` leg shows the Settings line; toggle-off leg has no `tracker.voice`; green under `-test-iterations 2`; `performAccessibilityAudit()` with the strip applied (skip only if the 26.5 runtime pin refuses it, and say so).
- [x] Scroll: `-apexFrameLog` six flings with the strip visible → late frames ≤ 1 (the D-054 baseline). Measured 2026-10-20 on the iPhone 17 / iOS 26.5 simulator with `-apexMockDense` and the failed strip up: six flings → **1 late frame** (gap 33 ms, 1 missed). The strip's first appearance after the mic tap cost one 209 ms gap (12 frames) while the eager 60-row content shifted under it with the animation, so the animation now covers only the strip's insertion and removal; the device's number is a scorecard row.
- [x] Docs: this brief's Status and Session log, STATUS row + recent line, `app-store.md` §3 recording script gains the two sheets, the memory note.

### M3 — Dogfood to default-on · Shane's device + ApexCore PRs
Goal lines. The first device session is **collection-only** (no parser edits): the journal fills
and the fixture's spellings get checked against real `formattedString`s (digits vs words, "2:25",
"for five" → "45", "5x5", casing of contextual strings).

**Numeric targets**

| Metric | Target | Measured by | Gates |
|---|---|---|---|
| A1 fixture pass | 100%; case count only rises | CI + the ratchet test | every parser PR |
| A2 correct auto-apply / clear-intent utterances | ≥ 80% TestFlight · ≥ 90% store | journal: applied ∧ ¬undone ∧ labelled correct at triage | TF default-on; store |
| A3 session name resolved without asking | ≥ 90% TF · ≥ 95% store | journal | TF; store |
| A4 wrong-exercise auto-apply | **0**; any occurrence blocks store until fixtured | Shane's label at triage | TF (0 in the sheet); store (0 in last 100) |
| A4′ wrong-value auto-apply | ≤ 1 in the sheet · ≤ 1% rolling 100 | same | TF; store |
| A5 undo rate | alarm > 10% / rolling 50 | journal | watch |
| A6 ask rate (confirm + unresolved) | 5–30% | journal | watch |
| A7 chosen alternative > 0 | report | journal | watch (is ranking earning its keep) |
| L1 tap → "Listening…" | p50 ≤ 300 ms · p95 ≤ 600 ms | journal `tapToListening` | TF |
| L2 last word → row visible | p50 ≤ 2.0 s · p95 ≤ 3.0 s | journal | TF |
| E1 end-reason mix | silence ≥ 70% · 8 s cap ≤ 10% | journal | watch (cap-heavy ⇒ widen windows) |
| O1 orange indicator off ≤ 2 s after end; never on idle | 100% of rows | scorecard | TF |
| B1 battery/thermal, 60 min, ≥ 30 utterances | ≤ voice-free baseline + 3 pts; thermal never `.serious` | Settings → Battery; journal | store |
| C1 crash-free | 0 over the sheet + 5 sessions | Xcode Organizer | TF; store |

**Device-run scorecard** (Shane, iPhone 15 Pro, TestFlight, toggle on; 10 scripted utterances per
utterance row, shaped like fixture cases 01–10 on today's exercises)

| # | Scenario | Expected | P/F |
|---|---|---|---|
| 1 | Quiet room, phone in hand | ≥ 9/10 correct; 0 wrong exercise | |
| 2 | Gym, music from the phone speaker | ducks on tap; ≥ 8/10; un-ducks ≤ 2 s after end | |
| 3 | Gym, AirPods playing music | music stays on AirPods, ducked, resumes; ≥ 8/10; input is the built-in mic | |
| 4 | Phone on the bench 1 m away, gym noise | ≥ 5/10 correct or asked; **0 false applies** | |
| 5* | Phone call mid-listen | failed/interrupted; nothing logged; next tap works | |
| 6* | Airplane mode | mic shown; 5/5 applied; pending-sync chip; flushes when back online | |
| 7* | Mic denied; speech denied; Dictation off in Settings | Settings line + link; after allowing, the next tap listens | |
| 8 | Exact library name not in session | confirm chip; tap adds + logs; Undo removes both | |
| 9 | Near name / plural | chip / applied as contained | |
| 10* | Nonsense ×5 ("okay um", "I'll be done in 5 minutes", humming) | nothing logged, every time | |
| 11 | Phrase-less "225 for 5" after scrolling elsewhere | lands on the last-logged exercise, strip names it, Undo works | |
| 12* | Orange indicator | off ≤ 2 s after each end; never on while idle | |
| 13* | Lock / background mid-listen | cancels, nothing logged, idle on return | |
| 14* | First-ever tap | Speech sheet then Microphone sheet with the plist wording; never at launch | |
| 15 | Second tap while listening | ends and applies ≤ 1 s | |
| 16 | Two utterances ≤ 2 s apart | second fills the next empty set; Undo reverts only it | |
| 17 | Undo before vs after sync | web shows no set (before) / previous value (after) | |
| 18* | Finished session; finish gate open | mic hidden; mic disabled | |
| 19 | kg profile, "sixty two and a half kilos for eight" | "62.5 kg" × 8 | |
| 20 | AX text size | strip readable, Undo tappable | |

Pass: every `*` row passes; utterance rows ≥ 45/50 correct-or-asked; A4 = 0 and A4′ ≤ 1 across
the sheet. One wrong-exercise auto-apply fails the sheet.

**Iteration loop and exit.** After each gym session Shane shares the voice log to the Mac and
pastes it into a session with one line per disputed entry. That session cuts
`fix/w17-voice-cases-<date>` (`git-new.sh --no-install`), records A2–A7, L1–L2, E1 for the session
in this brief's Session log **before** touching the parser, adds one `journal:<date>` case per
failed/undone/disputed utterance (red), changes rules (green), runs the reviewer, opens the PR. The
ratchet N rises; no case is deleted or weakened. One ApexCore-only, unheld, babysitter-merged PR
per gym session; a UI/adapter change is its own unheld PR; a change to a held file is its own small held
PR. **Exit:** two consecutive sessions of ≥ 20 utterances with zero new failure-sourced
cases and A2 ≥ 90% → flip the default on (one-line PR), record the library auto-apply decision on
the evidence, close W17. **Budget:** if not reached by the 6th device session, stop and decide
D-060 (confirm-everything, a custom language model, or a server-fallback toggle) rather than
tuning forever.

Acceptance:
- [ ] Scorecard passed on a TestFlight build with the toggle on; the sheet attached below.
- [ ] ≥ 100 journal utterances over ≥ 5 real sessions; the store-gate rows met.
- [ ] Every failed utterance is a `journal:<date>` fixture case in a merged PR; the exit met.
- [ ] Default flipped on (one-line PR); D-059 updated with the library auto-apply decision.

## Risks
1. Engine output ≠ fixture spellings → collection-only first session, the alternative ranker,
   contextual strings, journal → fixture.
2. On-device availability or quality (the Dictation toggle, assets, locale) → PR-H pins; runtime
   error mapping with Settings guidance; scorecard rows 6/7; a fallback is D-060, never a silent flip.
3. Audio route and lifecycle (A2DP, ducking never undone, interruption, a leaked session) →
   `.allowBluetoothA2DP` pin, the teardown order, rows 2/3/5/12/13, O1.
4. A large PR behind `shipit` while main churns → PR-H tiny and first; M1/M2 unheld; STATUS
   conflicts "keep both sides".
5. Trust loss from a wrong target → the strip always names the exercise, the Undo window, library
   confirm-first, the A4 = 0 rule, row 11.

Estimate: PR0 0.5 · PR-H 1 (+ shipit latency) · M1 2.5 · M2 3 · M3 2–3 Claude sessions across 5–6
gym days. Critical path: PR0 → (PR-H ∥ M1) → M2 → TestFlight → sheet → ≥ 2 journal PRs → exit →
default-on → store (behind 1.0's approval).

## Decisions (D-059 in decisions.md)
1. On-device Speech only; no LLM, no network; no server fallback in v1.
2. The parser and resolver are Swift-origin logic in ApexCore under the D-023/D-024 rule; the
   JSON fixture under the test target is the grammar's contract; `NearMatch` is recorded as the
   port it already is; `voiceKey` deliberately differs from the picker's `normalize`.
3. Session exact and contained matches auto-apply with Undo; near, unknown and (v1) library hits
   confirm first; library auto-apply is promoted on M3 evidence.
4. Typed parser values, one storage formatter; a bare spoken weight is stored bare (typed parity).
5. The spoken set goes through `TrackerEditor` like keystrokes: ghost cleared, nothing unsaid
   logged, deterministic `revert`, and the replay reset for planned rows.
6. `ApexSpeech` is a product like `ApexHealth`; `Speech`/`AVFoundation`/`AVFAudio` join the
   ApexCore import ban.
7. Ships dark behind `apex.tracker.voice`; the transcript-only journal is the instrument; the
   fixture only grows; `MARKETING_VERSION` never moves in a W17 PR.

## Not verified by the planning pass
`contextualStrings` and `addsPunctuation` honoured on-device; `isFinal` latency after
`endAudio()` on-device; whether the `sdk:` lines are needed; AirPods under `.duckOthers` +
`.allowBluetoothA2DP` (an iOS 18.4 forum report of AirPods-processed input); the permission-sheet
footer for on-device-only apps; the `.search` task hint's effect on endpointing; dictation's
number formatting ("2:25", "for five" → "45"); `performAccessibilityAudit` on the 26.5 runtime.
Pin each in PR-H on a Mac and a device; the brief's spellings are a hypothesis until the first
journal.

## Session log
- 2026-10-20 · Mac · Brief drafted from the approved plan (rev 2). Three read-only explorers
  (web tracker, iOS tracker and board, API and spec process), three design passes (parser, web
  integration, iOS workstream) and three independent reviews (software architecture, voice
  engineering, head of development) reconciled; Shane chose iOS-native-only and log-with-Undo.
  The reviews added the replay reset, the deterministic `revert`, `clearShadow`, typed parser
  values, state on `TrackerModel`, the held-plumbing-first partition, the dark toggle, library
  confirm-first, the journal, the A2DP route, the runtime error mapping and the grammar-aware
  end-of-utterance windows; rejected: a `field-not-logged` state (the editor already grows a
  column for any value), a contested "225 45" case, a shared exact-match helper, HFP and the
  iOS 26 adapter in v1, pre-warming the engine. No code. PR-H and M1 proposed as parallel lanes.

- 2026-10-20 · Mac · **M2 built** on `feat/w17-voice-logging` → PR #484 (branched from main with PR-H #480 and M1
  `feat/w17-voice-parser` merged in; the merged base built and tested green before a line of M2 was
  written). `VoiceLogState` + `TrackerModel+Voice.swift` (tap, both sheets, the listen, the
  end-of-utterance policy as a 100 ms real-time tick that reads the injected clock — `voiceTick()` is
  what the tests drive — apply through `applySpoken`, Undo restoring the whole `RestTimer`, chips,
  Pick…, cancel on background and the finish gate, the journal entry per utterance), `VoiceStrip` +
  `VoiceMicButton`, the mic in `TrackerHeader`, the You → Training toggle with "Share voice log"
  (a `ShareLink` over a lazily written JSON file) and "Clear voice log", `VoiceJournal` (ApexCore) +
  `FileVoiceJournalStore` (ApexPersistence, `Application Support/voice-journal.json`),
  `SpeechRecognizing.audioRoute()`, `-apexMockSpeech` now writes the toggle. 21 + 10 + 5 new unit
  tests, 11 strip/mic snapshots + `you-training-voice` (and `-axxxl`), three smoke legs. Snapshot lesson: the
  references were recorded on a simulator whose Dynamic Type is **medium** (`xcrun simctl ui <udid>
  content_size medium`); a fresh simulator renders larger text and fails every suite — set it, and
  the untouched references match byte for byte. The six You root references are re-recorded (the
  Training section gained three rows); `summary-volume` (last recorded by #466) differs by
  sub-pixel bytes with an identical render and is left alone. Deviations from the brief:
  `confirming`/`unresolved` carry the `SpokenIntent` (so a confirmed `repeat` works), `failed`
  carries the `SpeechFailure` and the reason, `denied(reason:)` covers Dictation-off and
  assets-missing too, a dismiss on the ask/failed strips, the model tests live in
  `VoiceLoggingTests.swift`. Device run still Shane's: the pins in #480's body plus this
  milestone's scorecard rows.

## Next brief
**PR-H — the held plumbing.** Goal: the `ApexSpeech` product (protocol, `No…`, Fake, SF adapter
with the audio-session, teardown and error-mapping rules above), `TrackerServices.speech`,
`AppModel.speechRecognizer()`, `-apexMockSpeech`, the two usage strings, the project.yml and
ci-guards lines, the app-store.md and testing-and-ci.md rows — and nothing user-visible.
Acceptance: the four PR-H boxes, the SDK pins answered in the PR body. Owns:
`ios/Packages/ApexKit/Sources/ApexSpeech/` (new), `ios/Packages/ApexKit/Package.swift`,
`ApexFeatures/Tracker/TrackerDependencies.swift`, `ios/Apex/{AppModel.swift,Mock/MockEnvironment.swift}`,
`ios/ApexTests/SpeechAdapterTests.swift`, the three held files, `docs/ios/{app-store,testing-and-ci}.md`.
Forbidden: `ios/Packages/ApexCore/**` (M1's), `TrackerModel.swift`/`TrackerScreen.swift` (M2's),
`src/`, `vercel.json`, `PrivacyInfo.xcprivacy`, the entitlements, `legal/`. Mac session; opens
the PR without the label — Shane grants `shipit`.
**M1 — the parser** can run in parallel in its own worktree. Goal: the types, tokenizer,
numbers, slot rules, resolution tiers, scoring, `VoiceStorage`, the fixture with all 59 cases and
the editor primitives (`clearShadow`, `applySpoken`, `revert`, `currentExercise`, the replay
reset), red-to-green. Acceptance: the eight M1 boxes. Owns: `ios/Packages/ApexCore/Sources/ApexCore/Tracker/Voice/`
(new), `ApexCore/Tracker/TrackerEditor.swift` (additive), `ApexCore/Library/NearMatch.swift`,
`ios/Packages/ApexCore/Tests/ApexCoreTests/` (the fixture, `TestFixtures.local(_:)`, the tests), `ios/Packages/ApexCore/Package.swift` (the `exclude` line).
Forbidden: everything outside `ios/Packages/ApexCore/`. Any machine; `swift test` is the gate.
