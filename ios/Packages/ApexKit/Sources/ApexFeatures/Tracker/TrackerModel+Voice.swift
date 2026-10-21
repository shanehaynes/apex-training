import ApexCore
import ApexSpeech
import Foundation
import SwiftUI
import UIKit

/// What the voice strip and the mic show (W17, D-059). Value-typed on
/// `TrackerModel` like `rest`, `gate` and `summary`; the strip is a pure view
/// over it, and every transition is a method below.
public enum VoiceLogState: Equatable, Sendable {
    case idle
    /// The two system sheets are up (the very first tap).
    case requesting
    /// `listen` was called; the microphone is not live yet.
    case activating
    case listening(partial: String, heardSpeech: Bool)
    /// `finish()` was called: the final is on its way, or its deadline is.
    case finishing(partial: String)
    /// The set is on the row; Undo is offered for a while.
    case applied(VoiceApplied, label: String)
    /// "Did you mean": the intent is kept and applied on a chip tap; the
    /// phrase is what Pick… searches for (empty when no name was said).
    case confirming(SpokenIntent, phrase: String, candidates: [SpokenExercise.Candidate])
    /// No exercise by that name anywhere: Pick… or Try again.
    case unresolved(phrase: String, intent: SpokenIntent)
    /// A reason and Try again; the recognizer's failure when it named one.
    case failed(SpeechFailure?, reason: String)
    /// Fixed in Settings: a refused sheet, Dictation off, the assets missing.
    case denied(reason: String)
    case unavailable
}

/// One listen's bookkeeping, from the tap to the row — the journal's timings
/// come from here, read off the injected clock.
struct VoiceSession {
    var generation: Int
    var utterance: SpeechUtterance
    var tapAt: Date
    var listeningAt: Date?
    var lastPartialAt: Date?
    /// Speech was detected (the empty partial) but nothing recognised yet:
    /// the no-speech budget counts from here instead of from `.listening`.
    var detectedAt: Date?
    var lastPartial = ""
    var window: Double = 1.5
    var heardSpeech = false
    var finishingAt: Date?
    var finalAt: Date?
    var endReason: VoiceJournalEntry.EndReason?
}

extension TrackerModel {
    // MARK: - What the screen reads

    /// You → Training's choice (`apex.tracker.voice`).
    public var voiceEnabled: Bool { UserDefaults.standard.bool(forKey: Self.voicePreferenceKey) }

    /// The mic exists: the toggle is on, a recognizer can run on this device,
    /// and the workout is not over.
    public var showsVoice: Bool {
        guard voiceEnabled, !isFinished else { return false }
        if case .available = services.speech.availability() { return true }
        return false
    }

    /// Shown but not tappable: the tracker is loading, the finish gate or the
    /// summary is up.
    public var voiceDisabled: Bool { phase != .ready || gate != .idle || summary != nil }

    /// What "Pick…" opens the picker with.
    public var voicePhrase: String {
        switch voice {
        case .unresolved(let phrase, _), .confirming(_, let phrase, _): return phrase
        default: return ""
        }
    }

    // MARK: - The policy's numbers

    /// Nothing heard for this long after `.listening` → the mic goes off.
    public static let noSpeechSeconds: Double = 5
    /// A listen never runs longer than this; the utterance is finished at the cap.
    public static let capSeconds: Double = 8
    /// After `finish()`, how long the final may take before the last partial is parsed instead.
    public static let finalDeadlineSeconds: Double = 1.5
    /// How long Undo stays offered (never while VoiceOver runs).
    public static let undoSeconds: Double = 15

    /// What "Pick…" may add: anything that logs as sets — never cardio, whose
    /// row takes no spoken set.
    public static let voiceAddableCategories = ["strength", "stretch", "mobility", "skill"]

    public static let noSpeechReason = "Didn't hear anything — try again"
    public static let notASetReason = "Didn't catch a set — try 'bench 225 for 5'"
    public static let deniedReason = "Microphone or speech recognition is off for Apex"
    public static let dictationOffReason = "Siri & Dictation is off in Settings"
    public static let assetsMissingReason = "On-device speech isn't installed for English yet"
    public static let notASetRowReason = "Voice logs sets only — not cardio or pitches"
    public static let nothingToRepeatReason = "Nothing logged yet to repeat"
    public static let staleCandidateReason = "That exercise isn't in today's workout anymore — try again"
    public static let noMicrophoneReason = "The microphone never started — try again"

    // MARK: - Taps

    /// The mic. A second tap while listening ends the utterance; otherwise a
    /// new listen, after both sheets on the very first one. Ends any Undo offer.
    public func tapMic() {
        switch voice {
        case .listening, .activating:
            finishListening(.tap)
            return
        case .requesting, .finishing:
            return
        default:
            break
        }
        voice = .idle
        stopVoiceTimer()
        Task { await startListening() }
    }

    public func retryVoice() { tapMic() }

    /// Undo the last spoken set: every row back as it was, ghost included,
    /// the rest exactly as it stood before, one save.
    public func undoSpoken() {
        guard case .applied(let applied, _) = voice else { return }
        editor.revert(applied)
        // The rest goes back to what it was before the set — unless a set
        // typed on another row since started its own, which stays.
        if let before = voiceRestBefore, rest.endsAt == voiceRestAfter?.endsAt {
            rest = before
            restChanged()
        }
        voiceRestBefore = nil
        voiceRestAfter = nil
        voiceAppliedAt = nil
        scheduleSave()
        services.journal.markLastUndone()
        voice = .idle
        stopVoiceTimer()
    }

    /// A "Did you mean" chip: a session exercise takes the set; a library hit
    /// is added for today first (and Undo removes both).
    public func confirmSpoken(_ candidate: SpokenExercise.Candidate) {
        guard case .confirming(let intent, _, _) = voice else { return }
        switch candidate.scope {
        case .session:
            guard let target = sessionTarget(id: candidate.id) else {
                fail(.failed(nil, reason: Self.staleCandidateReason))
                return
            }
            apply(intent, section: target.section, exerciseId: target.id)
        case .library:
            guard let definition = definitions.first(where: { $0.id == candidate.id }) else {
                fail(.failed(nil, reason: Self.staleCandidateReason))
                return
            }
            logOnAddedExercise(definition, intent: intent)
        }
    }

    /// "Pick…": the chosen movement is added for today and the set goes on it.
    public func pickSpoken(_ definition: ExerciseDefinition) {
        let intent: SpokenIntent
        switch voice {
        case .confirming(let pending, _, _), .unresolved(_, let pending): intent = pending
        default: return
        }
        logOnAddedExercise(definition, intent: intent)
    }

    /// The screen's scene phase. Only the background cancels: the permission
    /// alerts, Control Center and a banner make the scene *inactive*, and a
    /// listen (or an offer) must survive those — the first tap's two sheets
    /// above all.
    public func scenePhaseChanged(_ phase: ScenePhase) {
        if phase == .background { cancelVoice() }
    }

    /// The strip's dismiss: back to nothing, nothing changes.
    public func dismissVoice() {
        switch voice {
        case .applied, .confirming, .unresolved, .failed, .denied, .unavailable:
            voice = .idle
            stopVoiceTimer()
        default:
            break
        }
    }

    /// The tracker went to the background, the finish gate opened, the
    /// workout is being cancelled, the screen closed: the microphone goes off
    /// and nothing is applied. An offer or an ask is dropped too — whatever
    /// comes next is a different moment.
    public func cancelVoice() {
        guard voice != .idle else { return }
        switch voice {
        case .activating, .listening, .finishing:
            listenTask?.cancel()
            record(action: .failed, alternatives: [], parse: nil, endReason: .cancelled)
        default:
            break
        }
        voiceGeneration += 1
        listenTask = nil
        voiceSession = nil
        voice = .idle
        stopVoiceTimer()
    }

    // MARK: - The listen

    func startListening() async {
        guard showsVoice, !voiceDisabled else { return }
        let tapAt = services.clock.now
        voiceGeneration += 1
        let generation = voiceGeneration
        var authorization = services.speech.authorization()
        if authorization == .notDetermined {
            voice = .requesting
            authorization = await services.speech.requestAuthorization()
            // Cancelled while the sheets were up (background, the gate).
            guard voiceGeneration == generation, voice == .requesting else { return }
        }
        switch authorization {
        case .authorized: break
        case .denied:
            fail(.denied(reason: Self.deniedReason))
            return
        case .notDetermined:
            voice = .idle
            return
        case .unavailable:
            voice = .unavailable
            return
        }
        listenTask?.cancel()
        let utterance = services.speech.listen(bias: voiceBias())
        voiceSession = VoiceSession(generation: generation, utterance: utterance, tapAt: tapAt)
        voice = .activating
        startVoiceTimer()
        listenTask = Task { [weak self] in
            for await event in utterance.events {
                guard let self, !Task.isCancelled, self.voiceSession?.generation == generation else { return }
                self.handleVoiceEvent(event)
                switch event {
                case .final, .failed: return
                case .listening, .partial: break
                }
            }
        }
    }

    /// One event from the live utterance, on the main actor.
    func handleVoiceEvent(_ event: SpeechEvent) {
        let now = services.clock.now
        switch event {
        case .listening:
            voiceSession?.listeningAt = now
            // A second tap may already have ended it: the strip stays "finishing".
            guard voice == .activating else { return }
            voice = .listening(partial: "", heardSpeech: false)
            voiceListenCount += 1
        case .partial(let text):
            guard var session = voiceSession else { return }
            if text.isEmpty {
                // Speech detected, nothing recognised yet: the no-speech budget
                // restarts from here; the silence window waits for a transcript.
                if session.lastPartial.isEmpty { session.detectedAt = now }
            } else {
                session.heardSpeech = true
                session.lastPartialAt = now
                session.lastPartial = text
                session.window = Self.window(for: text, context: voiceContext())
            }
            voiceSession = session
            switch voice {
            case .activating, .listening: voice = .listening(partial: session.lastPartial, heardSpeech: true)
            case .finishing: voice = .finishing(partial: session.lastPartial)
            default: break
            }
        case .final(let alternatives):
            voiceSession?.finalAt = now
            settle(alternatives, endReason: voiceSession?.endReason ?? .final)
        case .failed(let failure):
            handleVoiceFailure(failure)
        }
    }

    /// The end-of-utterance policy against the injected clock, run every
    /// 100 ms while the strip is up — and by the tests directly.
    public func voiceTick() {
        let now = services.clock.now
        switch voice {
        case .activating, .listening:
            guard let session = voiceSession else { return }
            guard let since = session.listeningAt else {
                // The microphone never came up: the cap bounds that too.
                if now.timeIntervalSince(session.tapAt) >= Self.capSeconds { endWithoutMicrophone() }
                return
            }
            if !session.heardSpeech {
                if now.timeIntervalSince(session.detectedAt ?? since) >= Self.noSpeechSeconds { endWithoutSpeech() }
            } else if let last = session.lastPartialAt, now.timeIntervalSince(last) >= session.window {
                finishListening(.silence)
            } else if now.timeIntervalSince(since) >= Self.capSeconds {
                finishListening(.cap)
            }
        case .finishing:
            guard let session = voiceSession, let at = session.finishingAt,
                  now.timeIntervalSince(at) >= Self.finalDeadlineSeconds else { return }
            settleWithLastPartial()
        case .applied:
            guard let at = voiceAppliedAt, now.timeIntervalSince(at) >= Self.undoSeconds,
                  !UIAccessibility.isVoiceOverRunning else { return }
            voiceAppliedAt = nil
            voice = .idle
            stopVoiceTimer()
        default:
            break
        }
    }

    /// The silence window after a partial: 1.0 s when it already reads as a
    /// set with two values, 2.0 s when it ends in a connective or names an
    /// exercise with no values yet (more is coming), else 1.5 s.
    public static func window(for partial: String, context: VoiceContext) -> Double {
        let trimmed = partial.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return 1.5 }
        if let last = trimmed.split(separator: " ").last, connectives.contains(String(last)) { return 2.0 }
        let parse = VoiceParser.parse(trimmed, context: context)
        switch parse.status {
        case .ok:
            if case .log(_, let values)? = parse.intent, values.valueCount >= 2 { return 1.0 }
            return 1.5
        case .empty: return 2.0
        case .invalid: return 1.5
        }
    }

    static let connectives: Set<String> = ["for", "at", "x", "by", "times", "of", "and", "plus", "minus"]

    func finishListening(_ reason: VoiceJournalEntry.EndReason) {
        guard var session = voiceSession else { return }
        session.finishingAt = services.clock.now
        session.endReason = reason
        voiceSession = session
        voice = .finishing(partial: session.lastPartial)
        session.utterance.finish()
    }

    /// `listen` never reached `.listening` within the cap.
    func endWithoutMicrophone() {
        listenTask?.cancel()
        record(action: .failed, alternatives: [], parse: nil, endReason: .failed)
        voiceSession = nil
        listenTask = nil
        fail(.failed(.noInput, reason: Self.noMicrophoneReason))
    }

    /// Five seconds with nothing heard: the microphone goes off, nothing is parsed.
    func endWithoutSpeech() {
        listenTask?.cancel()
        voiceSession?.endReason = .noSpeech
        record(action: .failed, alternatives: [], parse: nil, endReason: .noSpeech)
        voiceSession = nil
        listenTask = nil
        fail(.failed(.noSpeech, reason: Self.noSpeechReason))
    }

    /// The final never came: the last partial is the utterance, and the
    /// deadline is the moment the journal counts as its final.
    func settleWithLastPartial() {
        listenTask?.cancel()
        voiceSession?.finalAt = services.clock.now
        let last = voiceSession?.lastPartial ?? ""
        settle(last.isEmpty ? [] : [last], endReason: .deadline)
    }

    /// The utterance is over: parse, then log, ask, or explain. One journal
    /// entry either way.
    func settle(_ alternatives: [String], endReason: VoiceJournalEntry.EndReason) {
        let context = voiceContext()
        let parse = VoiceParser.parse(alternatives: alternatives, context: context)
        var action = VoiceJournalEntry.Action.failed
        defer {
            record(action: action, alternatives: alternatives, parse: parse, endReason: endReason)
            voiceSession = nil
            listenTask = nil
        }
        guard parse.status == .ok, let intent = parse.intent else {
            fail(.failed(nil, reason: Self.notASetReason))
            return
        }
        switch parse.exercise {
        case .resolved(scope: .session, let id, _, _):
            guard let target = sessionTarget(id: id) else {
                fail(.failed(nil, reason: Self.notASetReason))
                return
            }
            if apply(intent, section: target.section, exerciseId: target.id) { action = .applied }
        case .current:
            if let current = editor.currentExercise(lastLogged: lastLoggedKey) {
                if apply(intent, section: current.section, exerciseId: current.id) { action = .applied }
            } else {
                let candidates = context.session.prefix(4).map {
                    SpokenExercise.Candidate(scope: .session, id: $0.id, name: $0.name, match: .contained, distance: 0)
                }
                if candidates.isEmpty {
                    fail(.failed(nil, reason: Self.notASetReason))
                } else {
                    ask(intent, phrase: "", candidates)
                    action = .confirming
                }
            }
        case .resolved(scope: .library, let id, let name, let match):
            // v1 asks before a library name becomes today's exercise (D-059).
            ask(intent, phrase: name, [SpokenExercise.Candidate(scope: .library, id: id, name: name, match: match, distance: 0)])
            action = .confirming
        case .needsConfirmation(let phrase, let candidates):
            ask(intent, phrase: phrase, candidates)
            action = .confirming
        case .unresolved(let phrase):
            voice = .unresolved(phrase: phrase, intent: intent)
            voiceConfirmCount += 1
            stopVoiceTimer()
            action = .unresolved
        }
    }

    func handleVoiceFailure(_ failure: SpeechFailure) {
        let state: VoiceLogState
        switch failure {
        case .notAuthorized: state = .denied(reason: Self.deniedReason)
        case .dictationDisabled: state = .denied(reason: Self.dictationOffReason)
        case .assetsMissing: state = .denied(reason: Self.assetsMissingReason)
        case .noSpeech: state = .failed(.noSpeech, reason: Self.noSpeechReason)
        case .noInput: state = .failed(.noInput, reason: "No microphone is available")
        case .serviceFailed: state = .failed(.serviceFailed, reason: "Speech recognition isn't available right now")
        case .interrupted: state = .failed(.interrupted, reason: "Interrupted — try again")
        case .cancelled:
            // Replaced by a later listen: that one owns the strip now.
            voiceSession = nil
            listenTask = nil
            return
        }
        // A finish the recognizer answered with "nothing heard" keeps why it
        // was finished (the tap, the window, the cap): M3 triages on it.
        let reason = voiceSession?.endReason ?? (failure == .interrupted ? .interrupted : .failed)
        record(action: .failed, alternatives: [], parse: nil, endReason: reason)
        voiceSession = nil
        listenTask = nil
        fail(state)
    }

    // MARK: - Applying

    /// The spoken set through the typed path: `TrackerEditor.applySpoken`, the
    /// rest a keystroke would have started, the haptic, one save, Undo. False,
    /// with the reason on the strip, when the row cannot take a set.
    @discardableResult
    func apply(_ intent: SpokenIntent, section: String, exerciseId: String, addedExerciseId: String? = nil) -> Bool {
        let restBefore = rest
        guard var applied = editor.applySpoken(intent, section: section, exerciseId: exerciseId, unit: weightContext.unit) else {
            let reason: String
            if case .repeat = intent, editor.exercise(section: section, id: exerciseId).map(Self.takesSets) == true {
                reason = Self.nothingToRepeatReason
            } else {
                reason = Self.notASetRowReason
            }
            fail(.failed(nil, reason: reason))
            return false
        }
        if let addedExerciseId { applied.kind = .addedExercise(id: addedExerciseId) }
        voiceRestBefore = restBefore
        for key in applied.keys { restCommitted(key) }
        voiceRestAfter = rest
        loggedSetCount += applied.keys.count
        lastLoggedKey = applied.keys.last
        scheduleSave()
        voiceAppliedAt = services.clock.now
        let name = editor.exercise(section: section, id: exerciseId)?.exercise.name ?? ""
        voice = .applied(applied, label: Self.label(for: intent, exerciseName: name, unit: weightContext.unit))
        startVoiceTimer()
        return true
    }

    private func logOnAddedExercise(_ definition: ExerciseDefinition, intent: SpokenIntent) {
        let tracked = addExercise(definition)
        if !apply(intent, section: tracked.section, exerciseId: tracked.exercise.id, addedExerciseId: tracked.exercise.id) {
            // A row that cannot take the set (a cardio pick) is not left behind.
            editor.removeAddedExercise(section: tracked.section, exerciseId: tracked.exercise.id)
        }
    }

    /// An ask, a failure: nothing is timed in these states, so the tick stops.
    func ask(_ intent: SpokenIntent, phrase: String, _ candidates: [SpokenExercise.Candidate]) {
        voice = .confirming(intent, phrase: phrase, candidates: candidates)
        voiceConfirmCount += 1
        stopVoiceTimer()
    }

    func fail(_ state: VoiceLogState) {
        voice = state
        voiceFailCount += 1
        stopVoiceTimer()
    }

    /// A typed edit to a row the last utterance wrote ends its Undo offer.
    func voiceEdited(_ key: SetKey) {
        guard case .applied(let applied, _) = voice, applied.keys.contains(key) else { return }
        voiceAppliedAt = nil
        voice = .idle
        stopVoiceTimer()
    }

    /// "Logged Bench Press · 225 lb × 5 · RPE 8": the strip's line, from the
    /// same text the row stores, with the profile's unit named where the row
    /// keeps it implicit.
    public static func label(for intent: SpokenIntent, exerciseName: String, unit: Weight.Unit) -> String {
        let name = exerciseName.isEmpty ? "set" : exerciseName
        switch intent {
        case .repeat:
            return "Logged \(name) · same as last set"
        case .log(let sets, let values):
            let text = VoiceStorage.text(for: values, unit: unit)
            var weight = text.weight
            if let spoken = values.weight, !spoken.bodyweight, spoken.unit == nil, let bare = weight { weight = "\(bare) \(unit.rawValue)" }
            var parts: [String] = []
            switch (weight, text.reps) {
            case (let w?, let r?): parts.append("\(w) × \(r)")
            case (let w?, nil): parts.append(w)
            case (nil, let r?): parts.append("\(r) reps")
            case (nil, nil): break
            }
            if let duration = text.duration { parts.append(duration) }
            if let rpe = text.rpe { parts.append("RPE \(rpe)") }
            if values.isWarmup { parts.append("warm-up") }
            if sets > 1 { parts.append("\(sets) sets") }
            return "Logged \(name) · " + parts.joined(separator: " · ")
        }
    }

    // MARK: - What the parser and the recognizer are told

    /// Today's set-tracked exercises with their columns, which one the tracker
    /// is on, the profile's unit and the unarchived library.
    public func voiceContext() -> VoiceContext {
        let session = editor.groups.flatMap { group in
            group.exercises.filter(Self.takesSets).map { tracked in
                VoiceSessionExercise(
                    id: tracked.exercise.id, section: tracked.section, name: tracked.exercise.name,
                    definitionId: tracked.exercise.definitionId, fields: inputFields(for: tracked)
                )
            }
        }
        return VoiceContext(
            unit: weightContext.unit, session: session,
            currentExerciseId: editor.currentExercise(lastLogged: lastLoggedKey)?.id,
            library: definitions.filter { $0.archivedAt == nil }
        )
    }

    /// Names to bias recognition toward: today's exercises first (with any
    /// parenthetical split off), then the library's names and aliases, deduped,
    /// at most 100, plus "RPE". Names only — common words would dilute it.
    public func voiceBias() -> SpeechBias {
        var names: [String] = []
        func add(_ raw: String) {
            let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !names.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else { return }
            names.append(name)
        }
        for group in editor.groups {
            for tracked in group.exercises where Self.takesSets(tracked) {
                add(tracked.exercise.name)
                if let stripped = Self.withoutParenthetical(tracked.exercise.name) { add(stripped) }
            }
        }
        for definition in definitions where definition.archivedAt == nil {
            add(definition.canonicalName)
            definition.aliases?.forEach(add)
        }
        names = Array(names.prefix(99))
        add("RPE")
        return SpeechBias(names: names)
    }

    static func takesSets(_ tracked: TrackedExercise) -> Bool {
        !tracked.isCardio && tracked.cardio == nil && tracked.exercise.category != "climbing"
    }

    static func withoutParenthetical(_ name: String) -> String? {
        guard let open = name.firstIndex(of: "("), let close = name[open...].firstIndex(of: ")") else { return nil }
        let stripped = (name[..<open] + name[name.index(after: close)...]).trimmingCharacters(in: .whitespaces)
        return stripped.isEmpty || stripped == name ? nil : stripped
    }

    private func sessionTarget(id: String) -> (section: String, id: String)? {
        for group in editor.groups {
            for tracked in group.exercises where tracked.exercise.id == id { return (tracked.section, id) }
        }
        return nil
    }

    // MARK: - The tick

    func startVoiceTimer() {
        guard voiceTimerTask == nil else { return }
        // Real time, like the tracker's own tick: the injected clock only
        // answers "what time is it", and a test clock that jumps on every
        // sleep would spin this loop.
        voiceTimerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, !Task.isCancelled else { return }
                self.voiceTick()
            }
        }
    }

    func stopVoiceTimer() {
        voiceTimerTask?.cancel()
        voiceTimerTask = nil
    }

    // MARK: - The journal

    func record(action: VoiceJournalEntry.Action, alternatives: [String], parse: SpokenParse?, endReason: VoiceJournalEntry.EndReason) {
        let now = services.clock.now
        let session = voiceSession
        let summary = parse.map(VoiceJournalEntry.ParseSummary.init)
            ?? VoiceJournalEntry.ParseSummary(status: "none", intent: nil, exercise: "none", problems: [], ignored: [], score: 0, rules: [])
        func seconds(_ from: Date?, _ to: Date?) -> Double? {
            guard let from, let to else { return nil }
            return to.timeIntervalSince(from)
        }
        services.journal.append(VoiceJournalEntry(
            timestamp: now, build: Self.build, endReason: endReason, alternatives: alternatives, chosen: parse?.chosen ?? 0,
            parse: summary, action: action,
            tapToListening: seconds(session?.tapAt, session?.listeningAt),
            lastPartialToFinal: seconds(session?.lastPartialAt, session?.finalAt),
            finalToApplied: action == .applied ? seconds(session?.finalAt, now) : nil,
            thermalState: Self.thermal(ProcessInfo.processInfo.thermalState),
            audioRoute: services.speech.audioRoute()
        ))
    }

    static let build: String = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "dev"

    static func thermal(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }
}

extension SpokenValues {
    /// How many of the four columns were said.
    var valueCount: Int {
        [weight != nil, reps != nil, durationSeconds != nil, rpe != nil].filter { $0 }.count
    }
}
