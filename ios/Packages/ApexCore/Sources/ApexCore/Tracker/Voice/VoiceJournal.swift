import Foundation

/// One utterance as the dogfood loop reads it (W17 M3): what was heard, what
/// the parser made of it, what the tracker did, and how long each hop took.
/// Transcripts and outcomes only — never audio (D-059). Every failed or
/// undone entry is a fixture case waiting to be written.
public struct VoiceJournalEntry: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable { case applied, confirming, unresolved, failed }

    /// Why the listen ended: the silence window, the 8 s cap, a second tap,
    /// the recognizer's own final, nothing heard for 5 s, the final's deadline
    /// (the last partial was parsed instead), a cancel (background, the finish
    /// gate), an interruption, or a recognizer failure.
    public enum EndReason: String, Codable, Sendable {
        case silence, cap, tap, final, noSpeech, deadline, cancelled, interrupted, failed
    }

    /// What the parser made of the transcript, flattened for a JSON reader.
    public struct ParseSummary: Codable, Equatable, Sendable {
        public var status: String
        /// "log ×1 W225 R5", "repeat", or nil.
        public var intent: String?
        /// "session:fx-press exact", "current", "confirm[2]", "unresolved", "library:rdl exact".
        public var exercise: String
        public var problems: [String]
        public var ignored: [String]
        public var score: Int
        public var rules: [String]

        public init(status: String, intent: String?, exercise: String, problems: [String], ignored: [String], score: Int, rules: [String]) {
            self.status = status
            self.intent = intent
            self.exercise = exercise
            self.problems = problems
            self.ignored = ignored
            self.score = score
            self.rules = rules
        }

        public init(_ parse: SpokenParse) {
            status = parse.status.rawValue
            intent = parse.intent.map(Self.describe)
            exercise = Self.describe(parse.exercise)
            problems = parse.problems.map(\.rawValue)
            ignored = parse.ignored
            score = parse.score
            rules = parse.rules.sorted()
        }

        public static func describe(_ intent: SpokenIntent) -> String {
            switch intent {
            case .repeat: return "repeat"
            case .log(let sets, let values):
                var parts = ["log ×\(sets)"]
                if let weight = values.weight { parts.append("W" + VoiceStorage.weight(weight)) }
                if let reps = values.reps { parts.append("R\(reps)") }
                if let seconds = values.durationSeconds { parts.append("D\(seconds)") }
                if let rpe = values.rpe { parts.append("rpe\(rpe)") }
                if values.isWarmup { parts.append("warm") }
                return parts.joined(separator: " ")
            }
        }

        public static func describe(_ exercise: SpokenExercise) -> String {
            switch exercise {
            case .current: return "current"
            case .resolved(let scope, let id, _, let match): return "\(scope.rawValue):\(id) \(match.rawValue)"
            case .needsConfirmation(_, let candidates): return "confirm[\(candidates.count)]"
            case .unresolved: return "unresolved"
            }
        }
    }

    public var timestamp: Date
    /// The app build (CFBundleVersion) that heard it.
    public var build: String
    public var endReason: EndReason
    /// The recognizer's alternatives, best first; `chosen` is the one parsed.
    public var alternatives: [String]
    public var chosen: Int
    public var parse: ParseSummary
    public var action: Action
    /// Flipped when Undo was tapped within its window.
    public var undoneWithinWindow: Bool
    /// Seconds: tap → `.listening`; the last partial → the final; the final → the row.
    public var tapToListening: Double?
    public var lastPartialToFinal: Double?
    public var finalToApplied: Double?
    /// `ProcessInfo.thermalState` at the end ("nominal", "fair", "serious", "critical").
    public var thermalState: String
    /// "Built-in Microphone → Speaker", as the audio session had it.
    public var audioRoute: String

    public init(
        timestamp: Date, build: String, endReason: EndReason, alternatives: [String], chosen: Int, parse: ParseSummary,
        action: Action, undoneWithinWindow: Bool = false, tapToListening: Double? = nil, lastPartialToFinal: Double? = nil,
        finalToApplied: Double? = nil, thermalState: String, audioRoute: String
    ) {
        self.timestamp = timestamp
        self.build = build
        self.endReason = endReason
        self.alternatives = alternatives
        self.chosen = chosen
        self.parse = parse
        self.action = action
        self.undoneWithinWindow = undoneWithinWindow
        self.tapToListening = tapToListening
        self.lastPartialToFinal = lastPartialToFinal
        self.finalToApplied = finalToApplied
        self.thermalState = thermalState
        self.audioRoute = audioRoute
    }
}

/// The last `capacity` utterances, oldest first. A value; the stores below
/// keep one and persist it.
public struct VoiceJournal: Codable, Equatable, Sendable {
    public static let capacity = 200

    public private(set) var entries: [VoiceJournalEntry]

    public init(entries: [VoiceJournalEntry] = []) {
        self.entries = Array(entries.suffix(Self.capacity))
    }

    public mutating func append(_ entry: VoiceJournalEntry) {
        entries.append(entry)
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    /// The most recent entry was undone within its window.
    public mutating func markLastUndone() {
        guard !entries.isEmpty else { return }
        entries[entries.count - 1].undoneWithinWindow = true
    }

    public mutating func clear() { entries.removeAll() }

    /// The share-sheet export and the on-disk form: pretty, sorted keys, ISO
    /// dates, so a diff between two exports reads.
    public func exportJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> VoiceJournal {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(VoiceJournal.self, from: data)
    }
}

/// Where the journal lives. The tracker appends and marks undo; You → Training
/// exports and clears. Synchronous on purpose: a few hundred KB at most, and
/// an utterance's entry is written once, after the row.
public protocol VoiceJournalStoring: Sendable {
    func load() -> VoiceJournal
    func append(_ entry: VoiceJournalEntry)
    func markLastUndone()
    func clear()
}

/// The tests' and the previews' store: nothing persists.
public final class MemoryVoiceJournalStore: VoiceJournalStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var journal = VoiceJournal()

    public init(entries: [VoiceJournalEntry] = []) {
        journal = VoiceJournal(entries: entries)
    }

    public func load() -> VoiceJournal { lock.withLock { journal } }
    public func append(_ entry: VoiceJournalEntry) { lock.withLock { journal.append(entry) } }
    public func markLastUndone() { lock.withLock { journal.markLastUndone() } }
    public func clear() { lock.withLock { journal.clear() } }
}
