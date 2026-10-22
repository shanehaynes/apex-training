# W17 — Voice set logging

**Machine:** both (M1 Linux-able · PR-H and M2 Mac · M3 Shane's device) · **Depends on:** W4
(tracker + write queue), #466 (`Weight`) · **Unblocks:** —
**Status:** in progress — PR-H #480, M1 #483 (both merged 2026-10-20) and M2 #484 (merged 2026-10-21) are on `main`; TestFlight 1.1.0 (604) uploaded 2026-10-22 from `main` at 75096526 (#486), toggle off by default; M3 dogfood next (Shane turns the toggle on, then the scorecard); brief drafted 2026-10-20 (D-059), synced to the three lanes 2026-10-22
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
  indicator); the recognizer is created at sign-in beside `healthServices` (`ensureQueue`, #480) —
  `SFSpeechRecognizer(locale:)` touches no audio session until a listen.
- `FakeSpeechRecognizer` — `init(authorization:, availability:, script: [String], grantOnRequest: Bool = true)`
  with two drive modes: scripted (each `listen` plays `.listening`, the detection `.partial("")`,
  cumulative partials the way `SFSpeechRecognizer` hypotheses grow, then `.final([utterance])`;
  nothing heard ends `.failed(.noSpeech)`, never `.final([""])`) and step-wise (`emit(_:) -> Bool` —
  whether the event reached a live utterance — `emitFinal()`, `fail(_:)`) for end-of-utterance unit
  tests over `TestClock`. Records `requestCount`, `biases: [[String]]`, `finishCount`, `abortCount`,
  `isListening`; `finishDeliversFinal` (default on) reaches the "final never arrived" deadline path,
  `authorizationDelay` holds the sheets open and `yieldsListening = false` keeps `.activating` live
  (the last two added by M2); `setAuthorization`, `setAvailability` (as built in #480 and #484).

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
  `denied` and `unavailable` set those states; since #484 the literal `off` — or no flag — writes the
  toggle off and any script writes it on. (`fix/ios-mock-raw-interpolation` edits this file
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

**Outcome (#480, merged 2026-10-20 on Shane's `shipit`; one reviewer round folded in as 6a92400e).**
The `sdk:` lines were **not needed**: the Apex target links Speech and AVFAudio through
`ApexSpeech`'s imports (`otool -L Apex.app/Apex.debug.dylib` lists both frameworks; `project.yml`
has only the two product entries). Beyond the design above: `SpeechAuthorization` is also
`Equatable`; `NoSpeechRecognizer.listen` yields `.failed(.serviceFailed)` and ends instead of
hanging; `speechRecognitionDidDetectSpeech` yields one `.partial("")` before any hypothesis (M2
reads it as "speech heard", never as a transcript), and a task that finishes with nothing heard ends
`.failed(.noSpeech)`, never `.final([""])`; `finish()` stops the audio at once (tap → engine →
session) and lets the task deliver the final over the audio it already has, so the mic, the ducking
and the orange indicator end at the user's end of utterance, not when the final lands;
`authorization()` folds both sheets like `requestAuthorization()` (either denial → `.denied`, either
open question → `.notDetermined`); `.restricted` → `.denied`. Error mapping beyond the table:
`kLSRErrorDomain` 301 → `.cancelled` (the domain is part of the match, so a 201 from another domain
is `.serviceFailed`); an `SFSpeechErrorDomain` wrapper is looked under (`NSUnderlyingErrorKey`);
the failures the design left open are audio-session activation fails (a call, Siri) →
`.interrupted`, engine start fails → `.noInput`, no recognizer at `listen` or availability lost
mid-listen → `.serviceFailed`, an utterance replaced by a later `listen` → `.failed(.cancelled)`.
The observers are selector-based (one `removeObserver(self)` in teardown); the live utterance tears
itself down in `deinit`; each audio resource has one release flag, so an abort racing `start()`
releases exactly what was acquired after it. `failure(for:)` and `locale(preferring:)` are
`public static` so `ApexTests` can pin them. `-apexMockSpeech <anything else>` is a script and the
literals `denied` and `unavailable` are states; writing `apex.tracker.voice` on launch was left to
M2, which added it in #484 with a third literal — `off` (or no flag) writes the toggle off, any
script writes it on. Simulator fact: `availability()` on the iOS 26.5 simulator is
`.available(locale: "en-US")` — `supportsOnDeviceRecognition` is **true** there — so the
Fake-on-simulator rule in `AppModel`, not availability, keeps the simulator off the real engine.
Gate: CI's `xcodebuild … test` on a fresh iPhone 17 / iOS 26.5 simulator, ApexTests 397 (12/12
`SpeechAdapterTests`), ApexUITests 22, `check-deinits` counts 2 and 3, `agent:check` green; no file
under `__Snapshots__` changed (the opt-in compare on a fresh simulator fails every suite by text
metrics — environmental; M2 found the cure, `content_size medium`).

Acceptance:
- [x] `ios` job green; `ios/scripts/check-deinits.sh` clean; every snapshot byte-identical; no mic exists. — #480: CI `ios` green; 397 unit + 22 UI on the lane's simulator; counts 2 and 3; no snapshot file changed; nothing calls `listen` outside the tests.
- [x] `SpeechAdapterTests` over the Fake: `.listening` then partials then `.final`; cancelling the consumer ends the stream; `finish()` yields the final; `requestCount == 1` after one `requestAuthorization()`; `biases[0]` equals the names passed to `listen(bias:)`. — 12/12 in #480 (the scripted drive plays the detection `.partial("")` first; `finish()` with nothing heard is `.failed(.noSpeech)`).
- [x] SDK pins answered in the PR body (device and simulator), NOT VERIFIED where no device was attached — the table is in #480's body. Answered: the `sdk:` lines are **not needed** (autolinked; `otool -L`); `requiresOnDeviceRecognition`, `contextualStrings` and `addsPunctuation` exist in the iOS 26.5 SDK and the adapter sets them; `AVAudioApplication.requestRecordPermission` is `API_AVAILABLE(ios(17.0))` and compiles against the 17.0 target with no guard; the two strings are in `Info.plist` verbatim.
- [ ] The device-side pins — **NOT VERIFIED — needs the phone** (the iPhone 15 Pro was not connected): `supportsOnDeviceRecognition` on the 15 Pro (true on the 26.5 simulator); the bias honoured under on-device recognition; `addsPunctuation` honoured on-device; `requestRecordPermission` at runtime on an iOS 17 device (runtimes on the Mac: 18.6, 26.5); A2DP keeps AirPods music while listening; `.notifyOthersOnDeactivation` un-ducks; the permission sheets' wording and order on screen (nothing shows until the first mic tap). Also open and device-side: `isFinal` latency after `endAudio()`; the `.search` task hint (not set — the request keeps `.unspecified`); dictation's number formatting; AirPods-processed input under `.duckOthers` + `.allowBluetoothA2DP`. The M3 scorecard answers them: rows 14 and 7 (the sheets, denial, Dictation off), 2 and 12 (ducking, un-ducking, the indicator), 3 (A2DP), 5 and 13 (a call, lock), 1, 9 and 19 with the journal (the bias, punctuation, dictation's number shapes), 15 and L2 (`isFinal` latency).
- [x] The usage strings, project.yml, ci-guards and docs rows as above; `MARKETING_VERSION` untouched. — reviewer-verified in #480: the plist block byte-identical at the prescribed spot, the two `project.yml` product entries (plus one comment line) with `link: false` for ApexTests, the one-line `ci-guards.sh` extension, both docs rows (`**No**` bold like its neighbours); `MARKETING_VERSION` absent from the diff.

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
public struct SpokenParse: Equatable { status: ok|empty|invalid; transcript; chosen: Int; intent: SpokenIntent?; exercise: SpokenExercise; ignored: [String]; problems: [SpokenProblem]; rules: Set<String>; score: Int }  // rules: the slot rules that fired — public for the journal; each fixture case asserts it equal (dec. 12)
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
"chin up" and "pull ups" stay phrases; `body weight` is likewise one bigram); the repeat words
`again same repeat another more` and the bigrams `same again one more another one` (`more` and
`another` count alone too — dec. 31); the fillers `okay ok um uh did log just i the please oh`
(`oh` is a number only inside shorthand, `two oh five`; dec. 7); the noise words `to too won ate`
(never a number, never a name; reported as `ignored`; dec. 28); the articles `a an` (silent on
their own; dec. 7); and every number word. Connectives and fillers are never reported as `ignored`
(dec. 7); a leading `on` before other words says nothing (dec. 27; `on` alone stays a phrase and
asks). "dec. N" throughout this section is
item N of the **Grammar decisions recorded by M1** table below.

**Number words.** (1) English 0–9999: `a|an` before `hundred|thousand|half|minute` = 1, silent anywhere else (dec. 7); tens may
take one unit word; `hundred` multiplies the open group; `thousand` closes it; `and` is skipped
only right after `hundred`; a units word followed by a tens word stops. (2) Gym shorthand: one
word valued 1–9 followed by a tens group (tens[+unit] | teen | `oh|zero`+unit) → d×100 + group
(`two twenty five`→225, `one thirty five`→135, `three fifteen`→315, `two oh five`→205).
(3) Fractions: `point d…`, `and a half` (+.5), `and a quarter` (+.25). (4) **Never numbers:**
`for`, `to`, `too`, `won`, `ate` — homophones are settled by alternative ranking, never guessed:
`for` is a connective; `to too won ate` are noise, never a name either, reported as `ignored` (−5)
so a cleaner alternative wins (dec. 28, case 97). Digits never merge with neighbours. (5) **Clock as a number:** dictation may format "two twenty
five" as `2:25`; a `d:dd` clock (d 1–9, dd < 60) is the number d×100+dd **unless** the hint
contains `.duration`, in which case it is a duration; `h:mm:ss` is always a duration.
(6) `readDuration`: clock; `N minutes [M [seconds]]`; `N seconds`; `a minute`, `half a minute`,
`a minute thirty`, `a minute and a half`, `a minute and a quarter` (75 s), `N minutes and a
half|quarter` (dec. 21, case 82); fractional minutes.

**Slot rules** (in order; first hit wins per number):

| # | pattern | decision | example |
|---|---|---|---|
| R1 | number + weight unit | weight, unit kept | `225 pounds`, `225 lbs` |
| R2 | number + `rep(s)`, or `rep(s)` + number | reps | `5 reps` |
| R3 | number + `set(s)`; `set(s) of` + number | sets; the `of` number is what it is said to be — a unit → weight (R1), `rep(s)` → reps (R2), a duration → time (R5) — else a bare number's reading here (R12: the hint when it names one dimension, else the floor; a fraction is a weight unless the exercise logs only reps or only time) (dec. 23, 24); a set count with no value is `empty` (dec. 9) | `3 sets of 5`; `3 sets of 60 seconds` → sets 3, D60; `3 sets of 225` → sets 3, W225; `plank 3 sets of 60` → D60 |
| R4 | `rpe` adjacent to a number (digits or words) | rpe | `rpe 8`, `rpe eight` |
| R5 | number + duration unit, clock-as-duration, `a minute…` | duration | `45 seconds`, `plank 1:30` |
| R6 | `bodyweight`/`body weight`/`bw` [`plus`/`minus` N [unit]]; a bare `plus`/`minus` N [unit] with no bodyweight word is the same form (dec. 21) | BW forms | `weighted pull ups plus 25 for 5` → BW+25 R5 |
| R7 | `at` + number: weight empty → weight; else ≤10 → rpe; else `tooManyNumbers` | `5 at 225 at 8` | |
| R8 | pair joined by `for`/`at`/`x`/`by`/`times`, one side already marked | the other side takes the complementary slot: of marked reps → weight under `for`/`at`, and under `x`/`by`/`times` sets if ≤ 10 else weight (dec. 4); of a marked set count → a bare number's reading (hint, then the floor; a fraction is a weight unless the hint is reps-only or time-only; dec. 19, 24); of a marked duration under `x`/`by`/`times` → sets when it is an integer ≤ 10, else nothing completes the pair and it is invalid (`duplicateDuration`) (dec. 25) | `5 reps for 225` → W225; `3 x 5 reps` → sets 3; `225 for 5 sets` → sets 5, W225; `plank 3 x 60 seconds` → sets 3, D60 |
| R9 | unmarked `A for B` | A weight, B reps — unless exactly one side is above the floor, which is then the weight (dec. 20) | `225 for 5`, `2:25 for 5`; `5 for 225` → W225 R5 |
| R10 | unmarked `A at B` | A reps, B weight — unless exactly one side is above the floor (dec. 20) | `5 at 225`, `five at 225`; `225 at 5` → W225 R5 |
| R11 | unmarked `A x B` (`by`, `times`) | A≤10 and B≤30 → sets×reps; else reps=min, weight=max; a third item takes the next of [sets, reps, weight]; on a `[duration]` hint a bare `A x B` with one side ≤ 10 and A ≠ B is that many sets of a time (dec. 25) | `5x5`; `225x5`; `12 by 20`; `plank 3 x 60` → sets 3, D60 |
| R12 | lone bare number | hint `[duration]` → duration; hint has reps but not weight → reps; hint has weight but not reps → weight; otherwise (both, or an empty hint) a fraction → weight, N > 50 → weight, else reps | `plank 60`; `bench 225`; `bench 5`; `front squat 225` → W225 |
| R13 | bare pair A B (no connective, or `and`/comma) | exactly one > 50 → weight; both ≤ 50 → A reps, B weight + `barePair`; both > 50 → `ambiguousNumbers` | `5 225`; `10 20`; `225 185` |
| R14 | a third unmarked number, or a slot filled twice | `tooManyNumbers` / `duplicate…` → invalid | |
| R15 | `warm up`/`warmup` anywhere | isWarmup | |
| R16 | `again`/`same`/`same again`/`repeat`/`one more`/`another one`/`more`/`another` with no numbers (dec. 31); beside numbers a repeat word is an ignored word, not a repeat (dec. 8) | intent `repeat` | `again`; `again 5 at 225` → R5 W225, `again` ignored |
| R17 | sets absent → 1; outside 1–10 → `setsOutOfRange` | | `15 sets of 5` |

A reps slot that receives a non-integer value (`five and a half reps`, `7.5 reps`) raises
`repsNotInteger` (invalid).

**Grammar decisions recorded by M1** (#483, merged 2026-10-20; numbered as in its body's "Decisions
beyond the brief", each pinned by a fixture case or a test; the rule-table cells, the vocabulary,
`extractPhrase` and the tiers above already carry them):

| # | Decision | Pinned by |
|---|---|---|
| 4 | R8's complement under `x`/`by`/`times` when the marked side is reps: the other side is sets if ≤ 10, else weight (`3 x 5 reps` → 3 sets; `225 x 5 reps` → 225 lb). Under `for`/`at` it is always the weight. | case 75 pins the ≤ 10 half; `225 x 5 reps` → weight holds on `main` but no fixture case pins it (case 76 is a marked weight, case 08 fires R7, not R8) |
| 7 | Fillers and silence: `oh` is a number only inside shorthand (`two oh five`), elsewhere a filler; lone `a`/`an` are silent; connectives (`at for x by times and of`) and fillers are never reported as `ignored`. | cases 37, 42, 63 |
| 8 | A repeat word beside numbers is an ignored word, not a repeat; a repeat needs no number at all. | case 62 |
| 9 | `3 sets` alone is `empty` — a set count without a value is nothing to log. | case 61 |
| 10 | Containment forgives the plural the per-word singularise keeps: word membership (`sameWord`) accepts one trailing `s` either way, whatever the length (`ups` ∋ `up`, so `pull up` is contained in `Weighted Pull-Ups`; `presss` ∋ `press` too); the joined key is used only by the exact and near tiers. #483 describes this as a three-letter rule on the joined key; the code is per word. | case 60 |
| 17 | A name a keyword hides is never silently the current exercise (the A4 = 0 rule): `extractPhrase` skips leading flags (`warm up`, repeat words), recognises a session or library name whose words are keywords — the longer of the plain run and a known name wins, a tie goes to the known name — and, when neither the leading nor the trailing run yields a phrase, takes every plain word the rules skipped as the phrase, so "5 easy at 225" asks instead of applying. `body weight` is one name word. | cases 64–69, `VoiceExerciseTests.testANameIsNeverLostToAKeyword` |
| 18 | A write after an undo on the same key is an upsert, never also a delete: `takeSavePayload` drops a removal for any key it upserts (the queue's merge already reads a later upsert as reviving a removed key; the server runs both lists in one unordered batch). Also closes the pre-existing remove-extra → add-extra → type hole. | `TrackerEditorTests.testAWriteAfterARevertIsAnUpsertNotADelete` |
| 19 | A weight beside a set count stays a weight: R8's complement of a marked sets item is reps only when the other number is at or under the floor, else the weight; R3's `of` number above the floor is a weight (`3 sets of 225`). | cases 77–79 |
| 20 | The floor settles a pair said the other way round: `225 at 5` and `5 for 225` log weight 225 × 5 when exactly one side is above the floor; both-small and both-big pairs keep the connective's literal order. | cases 80, 81 |
| 21 | A bare `plus`/`minus` N [unit] is a bodyweight form (`weighted pull ups plus 25 for 5` → BW+25); `a minute and a quarter` is 75 s and `N minutes and a half` works too. | cases 82, 83 |
| 22 | Branch coverage: R13's one-big branch, R12's reps-only and weight-only hints, the R11 three-item chain, `reps N`, and R8's `x` complements each have a row. | cases 70–76 |
| 23 | The `of` number is what it is said to be, else what a bare number is here: `sets of 60 seconds` is a time (R5), `sets of 100 pounds` keeps its unit (R1), `sets of 5 reps` is reps (R2); a bare `of` number takes R12's reading — the hint when it names one dimension (`plank 3 sets of 60` → 60 s, `push ups 3 sets of 60` → 60 reps), else the floor. | cases 84–90 |
| 24 | A set count's other side reads the same way: R8's complement of a marked sets item is that bare reading, so `plank 3 sets for 60` is a time, and a fraction beside a set count is a weight (`42.5 for 3 sets`, `3 sets of 42.5`) — unless the exercise logs only reps or only time, where the hint wins and a fractional rep count is `repsNotInteger` (`push ups 3 sets of 42.5`); #483's wording says "always". | cases 91, 98, 99 |
| 25 | Sets of a time under `x`: a marked duration times a small number is sets (`plank 3 x 60 seconds`, `plank 1:30 x 3`), and on a timed exercise a bare `3 x 60` is three sets of 60 s, not a 60 weight × 3 reps (the count must be an integer ≤ 10 and the two numbers differ; `plank 60 x 90` falls back to R11's weight/reps reading). | cases 92–94 |
| 26 | A known name made only of flags or fillers never displaces the name that was said: with a plan line called "Warm-Up", `warm up bench 5 at 135` is a warm-up set on the bench and `warm up 5 at 135` a warm-up on the current exercise; a known name must contain a token that is neither a flag nor a filler, and it displaces a plain run only when it contains that run. | `testANameIsNeverLostToAKeyword` |
| 27 | A leading `on` before other words says nothing: `same again on bench`, `on bench 5 at 225` (`on` alone, as in `on 5 at 225`, is still a phrase and asks). | cases 95, 96 |
| 28 | The four number homophones are noise: `to too won ate` are never a number and never a name; they are reported as ignored (−5), which is how alternative ranking settles them. | case 97 |
| 29 | A known name may carry a digit: `45 degree back extension 25` names the library's "45 Degree Back Extension" and logs 25 reps. | case 100 |
| 30 | Undo restores an extra the athlete added by hand: `VoiceApplied.created` lists the extras the apply itself added; only those are dropped on `revert`, a hand-added empty extra comes back as it was, and both removals still go out. | `TrackerEditorTests.testRevertRestoresAnExtraTheAthleteAddedByHand` |
| 31 | Recorded, not changed: `more`/`another` alone count as repeat words; `225 lbs at 8` is an RPE by R7 before R8, as the rules are ordered; the floor stays unit-blind (`bench 40` on a kg profile is 40 reps) — the journal decides. | no fixture case: `225 lbs at 8` → rpe 8 and `more`/`another` alone → repeat hold on `main` (cases 16, 53 and 57 fire R4 and R10, not R7); cases for them are M3's to add; the floor: #483 "Not verified" |

#483's other decisions (1–3, 5–6, 11–16) restate this section or pin an implementation detail —
the ratchet, `NearMatch.budget` internal, R7 vs R10 at `at`, `N rpe`, the clock shapes, the empty
hint for `needsConfirmation`, the `rules` trace, the editor details, `VoiceStorage`'s `unit`
parameter, lenient decoding, no overflow traps on huge inputs — and live in the PR body.

`extractPhrase` (dec. 17, 26, 27, 29): fillers drop out of the text; leading flags the slot rules
will consume (`warm up`, a repeat word) are skipped; then the leading run of `word` tokens up to the
first number/clock/keyword, a trailing connective stripped — but a session or library name whose
words are keywords or number words is recognised as such (`bodyweight squat`, `quarter squat`,
`log press`, `45 degree back extension`; up to six words): the longer of the plain run and a known
name wins, a tie goes to the known name, and a known name must hold a token that is neither a flag
nor a filler (a plan line called "Warm-Up" never swallows the flag) and displaces a plain run only
when it contains it; else the trailing run after the last slot, a leading `on`/`of`/`for`/`the`
stripped (a leading `on` before other words says nothing — `on` alone stays a phrase and asks — and
the `on` before a trailing known name is taken with it); else every plain word the rules skipped is
the phrase, so "5 easy at 225" asks
instead of silently landing on the current exercise. Unconsumed words → `ignored`, never fatal.
A phrase with no values → `empty`.

**Exercise resolution.** `voiceWords`: split on non-alphanumerics, expand `wordShorthand`
(`db→dumbbell, bb→barbell, kb→kettlebell, ohp→overhead press, rdl(s)→romanian deadlift(s), dl→deadlift, sldl→stiff leg deadlift, chin(s)→chin up(s)`),
singularise per word (`ies→y`; drop a final `s` when length > 3 and not `ss`). `voiceKey` = words
joined, singularised once more. Each candidate gets two keys: the full name, and the name with a
parenthetical removed. Tiers, stop at the first that yields: **1 exact-session** (key equality
over session names + their definition's canonical name and aliases; one → `resolved(exact)`,
several → confirm) · **2 contained-session** (every phrase word ∈ candidate words, word membership
forgiving one trailing `s` either way — `pull up` ⊂ Weighted Pull-Ups, dec. 10; one →
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
  `VoiceApplied { keys: [SetKey], previous: [TrackedSet], kind: planned|extra|addedExercise(id), created: [SetKey] }`
  (`created` = the extras the apply itself added; dec. 30). Nil for cardio, climbing, or an unknown
  exercise. `repeat` copies only the three actuals (not RPE or the warm-up flag); the warm-up flag is
  set only when spoken (dec. 13).
- `revert(_ applied: VoiceApplied)` — deterministic: restore each `previous` verbatim (ghost
  back); if `previous.hasAnyActual || previous.isLogged` → `dirtySets.insert(key)` (the old row is
  re-sent); else → `dirtySets.remove(key)` and `removedSets.append(key)` (never both); an extra in
  `created` is dropped, a hand-added empty extra comes back as it was (dec. 30). A write after an
  undo on the same key is an upsert, never also a delete: `takeSavePayload` drops a removal for any
  key it upserts (dec. 18). Correct whether the voice save was flushed or not: the queue merges a later delete over an unsent upsert
  (`WriteQueue.swift:93-111`, `TrackerRows.swift:237-246`) and the server's delete of a missing
  row is a no-op (`workoutSessions.ts:385-394`).
- `currentExercise(lastLogged: SetKey?) -> (section, id)?` — the exercise of the last logged
  key, else the first set-tracked exercise with a set that has no actuals and is not logged. Never
  a cardio row or a climbing pitch (dec. 13).
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
session bench=Bench Press, squat=Back Squat, pullups=Weighted Pull-Ups, plank=Plank [duration],
pushups=Push-Ups [reps], sled=Sled Push [weight] (every other session exercise logs [weight, reps]),
hammer=Hammer Curl (alias Hammer Curls), dbcurl=Dumbbell Curl; library adds Front Squat, Romanian
Deadlift (alias Stiff-Leg Deadlift), Overhead Press, Ring Dips, Lat Pulldown, Lat Pulldown (Close
Grip), Incline Press (archived), Easy Run (cardio), Bodyweight Squat, Log Press, Quarter Squat,
45 Degree Back Extension (pushups, sled and those last four library names are M1's, for cases
60–100). `kg` = same with unit kg; `nocurrent` = currentExerciseId null.
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
| 60 | pull up 8 | R8 | session pullups contained | `up` ∈ `ups`: one trailing `s` forgiven per word (dec. 10) |
| 61 | 3 sets | — | current | empty: a set count alone (dec. 9) |
| 62 | again 5 at 225 | R5 W225 | current | ok, `again` ignored — not a repeat (dec. 8) |
| 63 | oh bench 225 for 5 | W225 R5 | session bench contained | `oh` a filler outside shorthand (dec. 7) |
| 64 | warm up bench 5 at 135 | warm R5 W135 | session bench contained | a leading flag does not hide the name (dec. 17) |
| 65 | bodyweight squat 20 | R20 | library exact (Bodyweight Squat) | a name made of keywords (dec. 17) |
| 66 | log press 5 at 135 | R5 W135 | library exact (Log Press) | a name beats a filler inside it (dec. 17) |
| 67 | quarter squat 5 at 225 | R5 W225 | library exact (Quarter Squat) | a name starting with a number word (dec. 17) |
| 68 | 225 for 5 on bodyweight squat | W225 R5 | library exact (Bodyweight Squat) | a trailing known name, `on` taken with it (dec. 17) |
| 69 | bodyweight pull ups for 8 | BW R8 | session pullups contained | a bodyweight flag before the name (dec. 17) |
| 70 | 5 225 | R5 W225 | current | R13, exactly one above the floor (dec. 22) |
| 71 | push ups 60 | R60 | session pushups exact | R12 reps-only hint (dec. 22) |
| 72 | sled push 45 | W45 | session sled exact | R12 weight-only hint (dec. 22) |
| 73 | 225 x 5 x 3 | sets3 W225 R5 | current | R11 chain, sets last (dec. 22) |
| 74 | reps 5 at 225 | R5 W225 | current | R2 `reps` before the number (dec. 22) |
| 75 | 5 reps x 3 | sets3 R5 | current | R8: marked reps × small → sets (dec. 4) |
| 76 | 225 lbs x 5 | W"225 lb" R5 | current | R8: marked weight × N → reps (dec. 4) |
| 77 | 225 for 5 sets | sets5 W225 | current | a weight beside a set count stays a weight (dec. 19) |
| 78 | 225 for 3 sets of 5 | sets3 W225 R5 | current | (dec. 19) |
| 79 | 3 sets of 225 | sets3 W225 | current | `of` number above the floor → weight (dec. 19) |
| 80 | 225 at 5 | W225 R5 | current | the floor settles R10's order (dec. 20) |
| 81 | 5 for 225 | R5 W225 | current | the floor settles R9's order (dec. 20) |
| 82 | plank for a minute and a quarter | D75 | session plank exact | storage `"1:15"` (dec. 21) |
| 83 | weighted pull ups plus 25 for 5 | BW+25 R5 | session pullups exact | bare `plus` (dec. 21) |
| 84 | 3 sets of 60 seconds | sets3 D60 | current | the `of` number is a time (dec. 23) |
| 85 | plank 3 sets of 90 seconds | sets3 D90 | session plank exact | (dec. 23) |
| 86 | 3 sets of 100 pounds (kg) | sets3 W"100 lb" | current | the `of` number keeps its unit (dec. 23) |
| 87 | 3 sets of 62.5 kilos | sets3 W"62.5 kg" | current | (dec. 23) |
| 88 | 3 sets of 5 reps at 225 | sets3 R5 W225 | current | R3 R2 R7 (dec. 23) |
| 89 | plank 3 sets of 60 | sets3 D60 | session plank exact | a bare `of` number by the hint (dec. 23) |
| 90 | push ups 3 sets of 60 | sets3 R60 | session pushups exact | (dec. 23) |
| 91 | plank 3 sets for 60 | sets3 D60 | session plank exact | the set count's other side by the hint (dec. 24) |
| 92 | plank 3 x 60 seconds | sets3 D60 | session plank exact | a count × a time is sets (dec. 25) |
| 93 | plank 1:30 x 3 | sets3 D90 | session plank exact | (dec. 25) |
| 94 | plank 3 x 60 | sets3 D60 | session plank exact | a bare pair under `x` on a timed exercise (dec. 25) |
| 95 | same again on bench | repeat | session bench contained | a leading `on` says nothing (dec. 27) |
| 96 | on bench 5 at 225 | R5 W225 | session bench contained | (dec. 27) |
| 97 | 5 to 225 | R5 W225 | current | ok, `to` ignored — noise, not a name (dec. 28) |
| 98 | 42.5 for 3 sets (kg) | sets3 W42.5 | current | a fraction beside a set count is a weight (dec. 24) |
| 99 | 3 sets of 42.5 (kg) | sets3 W42.5 | current | (dec. 24) |
| 100 | 45 degree back extension 25 | R25 | library exact (45 Degree Back Extension) | a name with a digit (dec. 29) |

Cases 01–59 are the planning pass's; **60–100 are M1's authored additions** (`source: "authored"`,
each named for its decision). The ratchet is `committedCaseCount = 100` (`VoiceFixtureTests`); it
only rises, and M3's `journal:<date>` cases count from 101.

Acceptance:
- [x] `swift test --package-path ios/Packages/ApexCore` green on Linux CI and a Mac; `npm run agent:check` green (ApexCore imports clean). — Mac and `agent:check` green in #483; `apexcore-linux` green on #483's CI and again on #484's, which merged `main` with M1 (#480's run predates M1).
- [x] `VoiceFixtureTests`: every case passes, failure messages name the case id; `XCTAssertGreaterThanOrEqual(cases.count, N)` with N committed (the only-grows ratchet); every rule R1–R17, every exercise tier and every `SpokenProblem` appears in ≥ 1 case; every case has a `source`. — N = 100 (#483).
- [x] `VoiceStorageTests`: each case's `storage` map matches the formatter; `for|to|too|won|ate` never read as numbers; clock-as-number vs clock-as-duration by hint.
- [x] `VoiceTokensTests`, `VoiceNumbersTests`, `VoiceExerciseTests` (keys, tiers in isolation, archived excluded, parenthetical, ordering, no phrase → current), `VoiceScoreTests` (ok > empty > invalid; resolved > current > confirm > unresolved; ties keep index).
- [x] `TrackerEditorTests`: `clearShadow` leaves the key clean; `applySpoken` fills the first empty planned set and clears its ghost, else adds an extra, spans `sets: 3`, copies the last set on `repeat`, returns nil for cardio/climbing; `revert` of a planned row with prior actuals re-dirties, of an empty prior row records a removal and never both; `currentExercise` fallback order; **replay of a removed planned key keeps the row** (reset, not removed).
- [x] `NearMatchTests`: session names get the picker's budget.
- [x] Opt-in perf (`APEX_PERF=1`): 1,000 parses × 5 alternatives over `upper` < 1 s. — 0.35 s, debug build.
- [x] Reviewer report under `## Review`; Session log line below; STATUS recent line. — two rounds, #483.

### M2 — The tracker · Mac · `feat/w17-voice-logging` · unheld · after PR-H and M1
Built in #484 (merged 2026-10-21). Where the text below and the code differ, #484's Decisions and
the M2 session-log line are the record: `confirming`/`unresolved` carry the `SpokenIntent` (a
confirmed `repeat` works); `failed(SpeechFailure?, reason:)`, `denied(reason:)` (the refused sheets,
Dictation off, assets missing) and `finishing(partial:)`; only `.background` cancels — an inactive
scene is the permission alerts, Control Center or a banner, and the first tap on a phone has to
survive it; the detection `.partial("")` restarts the 5 s no-speech budget and nothing else, its
silence window waits for a transcript; `.activating` is capped by the 8 s rule (`.failed(.noInput)`);
the ask/failed/denied strips have a dismiss and stop the 100 ms tick; `.confirming` carries the
spoken phrase so Pick… searches it, and a stale chip says so; Undo restores the rest only while the
running rest is still the apply's; `cancelVoice()` also drops an offer or an ask; "Clear voice log"
asks first; `loggedSetCount += keys.count` (one `3 sets of 5 at 225` utterance counts three), as the
State text says and against the acceptance box's "+1 per utterance"; an undo before the flush
sends no row but one removal for the key, which the server treats as a no-op (`VoiceLoggingTests`
asserts exactly that), against the box's "sends nothing for the key"; the near-miss smoke
utterance is `fixture prss`, not `fixture pres` — #484 says M1's plural rule would auto-apply
`pres` as a containment, but on `main` it would not: `voiceWords` singularises `pres` to `pre`, so
both spellings are near matches and chip, and the leg works with either.

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
- [x] `VoiceLoggingTests` (over `VoiceSupport.make(…)` with `speech:` injected — a new file, since `TrackerModelTests.swift` is claimed by another lane): first empty planned set filled and ghost cleared (`focusSet` then returns false); extra when none empty; `sets: 3` planned then extra; `repeat`; library hit → `.confirming`, tap adds + logs, Undo removes both; nil/`.failed` for cardio, pitch, finished; `loggedSetCount` +1 per utterance; save body carries `"actual_weight":"225"` bare and `"100 kg"` when spoken; rest starts on reps; undo restores the rest state captured before the apply (a rest it started stops, a rest that was already running resumes, and re-logging the reverted row starts its rest again); undo before the flush sends nothing for the key, after the flush sends a delete; Undo ends on a typed edit to the key, the next apply, the next mic tap, 15 s. [Sync note, from #484's Decisions and tests: `loggedSetCount += keys.count`, not +1 per utterance; an undo before the flush sends no row but one removal for the key, which the server treats as a no-op.]
- [x] End-of-utterance tests over `TestClock` and the step-wise Fake: 5 s no-speech; 1.0 / 1.5 / 2.0 s windows; 8 s cap; second tap; final deadline falls back to the last partial; background/gate/interruption cancel with nothing applied; `finalToApplied` ≤ 100 ms.
- [x] `VoiceLogStateTests`: denied; unavailable → no mic; dictation-disabled and assets-missing → Settings line; partials → transcript; exact → `.applied`; near → `.confirming` keeping values; unresolved; empty/invalid → `.failed`; `.current` with no current → `.confirming` ≤ 4; `biases[0]` names-first, ≤ 100, no common words.
- [x] `VoiceJournalTests`: ring ≤ 200, fields present, no audio bytes, JSON export round-trips.
- [x] Mic shown only when toggle ∧ available ∧ `!isFinished`; `ApexIcon.mic` passes the every-case design test; `VoiceStrip` identifiers as listed; snapshots recorded on a Mac.
- [x] `ApexUITests.testVoiceLoggingOnFixtures` (the `testTrackerOnFixtures` shape): `["-apexUITest","-apexMockClient","-apexMockSpeech","Fixture Press 115 for 4;fixture prss 120 for 3"]` ("prss", not "pres": M1's plural rule reads "pres" as "press" and auto-applies it as a contained match, so the near-miss leg needs a spelling the resolver can only near-match). [Sync note: on `main` `pres` is a near match too — `voiceWords` singularises it to `pre`, so containment never fires; both spellings chip.] Green under `-retry-tests-on-failure -test-iterations 2` on the first try (2026-10-20, iPhone 17 / iOS 26.5). The audit is `performAccessibilityAudit` with a handler that fails on any issue whose element is a `tracker.voice*` identifier and prints the rest: two pre-existing "Potentially inaccessible text" issues elsewhere on the tracker were printed, none on the voice elements with the toggle on (`MockEnvironment.speech()` writes `apex.tracker.voice` true on every launch and false for the `off` literal, so legs never leak into each other) → Start → `tracker.voice` → `tracker.voice.applied` → set-1 weight reads 115 → `tracker.voice.undo` → empty → mic → chip → 120; `-apexMockSpeech denied` leg shows the Settings line; toggle-off leg has no `tracker.voice`; green under `-test-iterations 2`; `performAccessibilityAudit()` with the strip applied (skip only if the 26.5 runtime pin refuses it, and say so).
- [x] Scroll: `-apexFrameLog` six flings with the strip visible → late frames ≤ 1 (the D-054 baseline). Measured 2026-10-20 on the iPhone 17 / iOS 26.5 simulator with `-apexMockDense` and the failed strip up: six flings → **1 late frame** (gap 33 ms, 1 missed). The strip's first appearance after the mic tap cost one 209 ms gap (12 frames) while the eager 60-row content shifted under it with the animation, so the animation now covers only the strip's insertion and removal; the device's number is a scorecard row.
- [x] Docs: this brief's Status and Session log, STATUS row + recent line, `app-store.md` §3 recording script gains the two sheets, the memory note.

Left to Shane and the device (#484's "Not verified"): every PR-H pin, the M3 scorecard rows, the
two sheets' order and wording, `.updatesFrequently` and the announcements under VoiceOver, Reduce
Motion on a phone, the real adapter's live paths (nothing in a simulator runs Apple's recognizer
against a microphone; the Fake stands in everywhere in #484); `finalToApplied ≤ 100 ms` is
wall-clocked on a Mac for the parse + apply pass — the phone's number is the journal's, a scorecard
row; the strip at widths other than 393 pt; the share sheet itself (a `ShareLink` over a
`Transferable` file — exercised by eye, not by a test). The accessibility audit fails only on
`tracker.voice*` elements; it printed two pre-existing "Potentially inaccessible text" issues
elsewhere on the tracker, not W17's to fix.

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

## Not verified (after PR-H #480, M1 #483 and M2 #484)
The union of the three PR bodies' lists, as they wrote them. Settled since the planning pass:
whether the `sdk:` lines are needed (not needed — `otool -L`, #480); `performAccessibilityAudit` on
the 26.5 runtime (runs; #484's smoke uses it); the Linux build and test of ApexCore
(`apexcore-linux` green on #483 and on #484, which carried M1).

PR-H (#480):
- Every device-side SDK pin — the iPhone 15 Pro was not connected: `supportsOnDeviceRecognition` on
  the 15 Pro; `contextualStrings` honoured under on-device recognition; `addsPunctuation` honoured
  on-device; `AVAudioApplication.requestRecordPermission` at runtime on iOS 17 (no iOS 17 device or
  runtime on the Mac); A2DP keeps AirPods music while listening; `.notifyOthersOnDeactivation`
  un-ducks; the permission sheet wording; `isFinal` latency after `endAudio()`; the `.search` task
  hint (not set — the request keeps `.unspecified`); dictation's number formatting; AirPods-processed
  input under `.duckOthers` + `.allowBluetoothA2DP`.
- The adapter's live paths — session activation, the tap, the engine, the task and its delegate
  callbacks, the observers, the teardown — are compile-checked, reviewed and reasoned about, not
  exercised: nothing in PR-H calls `listen`, Apple's Speech sample does not run in the simulator,
  and no phone was attached. M2's first device tap is the first real run; the construction path
  (`init`, `availability()`, `authorization()`) did run on the simulator.
- The permission sheets (wording, order, the on-device-only footer): not shown until M2.

M1 (#483):
- Real dictation spellings (digits vs words, `2:25`, `for five` → `45`, casing of contextual
  strings): M3's first collection-only session; the fixture's spellings are a hypothesis until then.
- `bareWeightFloor = 50` is unit-blind as the brief writes it, so on a kg profile `bench 40` is 40
  reps on a weight-and-reps exercise (a lb lifter's `bench 88` is a weight). Both reviews flagged
  it; left for the journal to decide (Decision 31).
- M2's use of `SpokenExercise.resolved` (it carries `id`, not `section`; the session entry in
  `VoiceContext` has both) — #484 consumes it as is.

M2 (#484):
- The device: every PR-H pin, the M3 scorecard rows, the two sheets' order and wording,
  `.updatesFrequently` and the announcements under VoiceOver, Reduce Motion on a phone, the real
  adapter's live paths (nothing in a simulator runs Apple's recognizer against a microphone; the
  Fake stands in everywhere here).
- The accessibility audit only fails on `tracker.voice*` elements; it printed two pre-existing
  "Potentially inaccessible text" issues elsewhere on the tracker, not this PR's to fix.
- `finalToApplied ≤ 100 ms` is wall-clocked on a Mac for the parse + apply pass; the phone's
  number is the journal's, a scorecard row.
- Widths other than 393 pt for the strip; the share sheet itself (a `ShareLink` over a
  `Transferable` file — exercised by eye, not by a test).

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
- 2026-10-20 · Mac · **PR-H** (`feat/w17-speech-surface`, #480, held; merged 2026-10-20 on Shane's
  `shipit`). `ApexSpeech` (protocol, `No…`, Fake with scripted and step-wise drive,
  `SFSpeechRecognizerAdapter` with the locale, availability, both-sheets, audio-session, teardown,
  observer and error-mapping rules), `TrackerServices.speech`, `AppModel.speechRecognizer()`,
  `MockEnvironment.speech()` / `-apexMockSpeech`, the two usage strings, `project.yml` (no `sdk:`
  lines needed — the app links Speech and AVFAudio through the package), the `ci-guards.sh` ban,
  the `app-store.md` and `testing-and-ci.md` rows, `SpeechAdapterTests`. Gate green on a fresh
  iPhone 17 / iOS 26.5 simulator; no snapshot file changed; `check-deinits` clean; `agent:check`
  green. One reviewer round folded in as 6a92400e (three minors, one spec gap and three not-checked
  items — wrapped errors, `deinit`, concurrent `stopAudio()`): an abort racing
  `start()` now releases what it acquired, the Fake matches the adapter's event sequence
  (`.partial("")` first; nothing heard → `.failed(.noSpeech)`), two tautological assertions made
  real, `authorization()` folds both sheets. The iPhone 15 Pro was not connected, so every device
  pin is NOT VERIFIED (listed in the PR and in the PR-H section above). No UI, no mic, nothing calls
  `listen` outside the tests. (This line lived in #480's body until the brief and the PR met.)
- 2026-10-20 · Mac · **M1** (`feat/w17-voice-parser`, #483, unheld). The parser, resolver,
  storage formatter and `TrackerEditor` primitives in ApexCore, red-to-green against the fixture:
  the 59 cases above plus 41 authored cases (60–100) pinning every decision the brief left open,
  each named for its decision, with each case's `rules` trace asserted equal to what fired. Two
  adversarial review rounds. Round 1: a name hidden by a keyword auto-applied to the current
  exercise (`warm up bench 5 at 135`, `bodyweight squat 20`, `log press 5 at 135`); a reverted key
  went out as upsert and delete in one save; 19-digit clocks and `twenty hundred` chains trapped;
  a weight beside a set count became reps (`225 for 5 sets`). Round 2: the `sets of` number
  dropped its unit or time (`3 sets of 60 seconds`, `[kg] 3 sets of 100 pounds`); a plan line
  called "Warm-Up" swallowed the spoken name; a leading `on`, the homophones, names with a digit,
  sets of a time under `x`, a hand-added extra on undo, and fractions beside a set count. All fixed
  and pinned (PR body, Decisions 17–31). Left as the brief states it: the unit-blind floor
  (`bench 40` on a kg profile is 40 reps) — the journal decides. `swift test` 641 green on a Mac,
  `agent:check` green; Linux is the PR's CI job. For this brief's next edit: `to too won ate` are
  noise and `oh` a filler in the keyword vocabulary; containment forgives a three-letter plural;
  `extractPhrase` recognises session and library names keywords and all, skips leading flags, and
  takes stray plain words as the phrase (never silently the current exercise); R3's `of` number and
  R8's set-count complement read a bare number by the hint, then the floor; R9/R10 settle a
  one-sided pair by the floor; a bare `plus N` is bodyweight plus N; `a minute and a quarter` is 75 s.
  M2 can start once PR-H lands: `VoiceContext`, `VoiceParser.parse(alternatives:context:)`,
  `editor.applySpoken(_:section:exerciseId:unit:)`, `editor.revert(_:)`, `editor.currentExercise(lastLogged:)`.

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
- 2026-10-22 · Mac · **Docs sync** (`chore/w17-brief-sync`, docs only). With PR-H #480, M1 #483 and
  M2 #484 on `main`, the brief says what the lanes built: the grammar text absorbs M1's decisions 7,
  10, 17 and 23–31 (and 4, 18–22, the sync's own additions: 19–21 are what the M1 log line above
  lists for this edit, 4, 18 and 22 complete the R8 cell, the editor text and the case notes) as the
  table under the slot rules, with the rule-table cells for R3, R6, R8–R11 and R16, the keyword
  vocabulary, the number
  words, `extractPhrase`, tier 2 and the editor primitives adjusted to match; the fixture table
  carries cases 60–100 and the ratchet 100; PR-H's outcomes and the Fake's final surface are
  recorded with the `sdk:` answer; the acceptance boxes #480 and #483's CI prove are ticked and the
  device-side pins stay open; M2's deviations and Shane's device checks are listed under M2; "Not
  verified" is the union of the three PR bodies; PR-H's session-log line moved here from its PR
  body; the Next brief is M3; TestFlight 1.1.0 (604) (#486) is in the status line, the Next brief and
  STATUS. One reviewer round on the sync (ten minors: pins cited that do not pin, wording broader
  than the code, two #484 contradictions unsurfaced, a stale flag literal) folded in. Nothing in
  the three PR bodies contradicts D-059. No code.

## Next brief
**M3 — dogfood to default-on (Shane's device first, then ApexCore PRs).** Goal: the voice journal
fills on a real phone and every utterance it gets wrong becomes a fixture case, until the exit
criterion above flips the default on. Order: (1) **Shane** — TestFlight 1.1.0 (604), uploaded
2026-10-22 from `main` at 75096526 (#486; it carries #480, #483 and #484 with the toggle off), on
the iPhone 15 Pro; You → Training → *Log sets by voice* on; then the device-run scorecard above in
its order — the rows the PR-H section's open box names answer #480's device-side pins (14 and 7
the sheets and denial, 2 and 12 ducking and the indicator, 3 A2DP, 5 and 13 a call and lock, 1, 9
and 19 with the journal the bias and dictation's number shapes, 15 and L2 `isFinal` latency); row 6
(airplane mode) is the offline promise. The first gym session is **collection-only**: no parser
edit; the journal goes to the Mac
from You → Training → *Share voice log*. (2) **One session per gym day**, from the shared JSON with
one line per disputed entry: `scripts/git-new.sh fix/w17-voice-cases-<date> "W17 M3: voice fixture
cases from <date>" --no-install`; record A2–A7, L1–L2 and E1 for the session in this Session log
**before** touching the parser; add one `journal:<date>` case per failed, undone or disputed
utterance (red); change rules (green); run the reviewer; open the PR (ApexCore-only, unheld,
babysitter-merged). The first collection session also settles the fixture's spellings against real
`formattedString`s (digits vs words, `2:25`, `for five` → `45`, casing of contextual strings) and
the unit-blind floor (`bench 40` on a kg profile). A UI or adapter change is its own unheld PR; a
change to a held file its own small held PR. Acceptance: the four M3 boxes above; the sheet attached
to this brief; the ratchet only rises. Owns (per fixture PR):
`ios/Packages/ApexCore/Sources/ApexCore/Tracker/Voice/`, `ios/Packages/ApexCore/Tests/ApexCoreTests/`
(the fixture and the voice tests), this brief's Session log and M3 section, `docs/ios/STATUS.md`.
Forbidden: everything outside `ios/Packages/ApexCore/` and `docs/ios/` unless the session's log
line says why; `ios/Fixtures/` (emitter-only); the held files; `MARKETING_VERSION`. Any machine;
`swift test --package-path ios/Packages/ApexCore` is the gate (`agent:check` for the Stop hook on a
Mac). Budget: six device sessions, then D-060 rather than tuning forever.
