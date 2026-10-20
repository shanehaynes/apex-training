import Foundation

// Voice set logging (W17, D-059): what one utterance in the tracker means.
// The parser (`VoiceParser`) emits these typed values; `VoiceStorage` is the
// one place they become the free text a set row stores. Swift-origin logic in
// ApexCore under the D-023/D-024 rule — it runs before any request exists —
// with the hand-authored fixture under ApexCoreTests/Fixtures as its contract.

/// A weight as it was said: a number with the unit the athlete spoke (nil when
/// none was — the profile unit is implied), or a bodyweight form (`BW`,
/// `BW+25`, `BW-10 kg`), where `sign` is −1 / 0 / +1 and `value` the load.
public struct SpokenWeight: Codable, Equatable, Sendable {
    public var value: Double?
    public var unit: Weight.Unit?
    public var bodyweight: Bool
    public var sign: Int

    public init(value: Double? = nil, unit: Weight.Unit? = nil, bodyweight: Bool = false, sign: Int = 0) {
        self.value = value
        self.unit = unit
        self.bodyweight = bodyweight
        self.sign = sign
    }

    private enum CodingKeys: String, CodingKey { case value, unit, bodyweight, sign }

    /// Lenient: the fixture spells only what a weight has (`{"value": 225}`,
    /// `{"bodyweight": true, "sign": 1, "value": 25}`).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = try c.decodeIfPresent(Double.self, forKey: .value)
        unit = try c.decodeIfPresent(Weight.Unit.self, forKey: .unit)
        bodyweight = try c.decodeIfPresent(Bool.self, forKey: .bodyweight) ?? false
        sign = try c.decodeIfPresent(Int.self, forKey: .sign) ?? 0
    }
}

/// Every value one utterance can carry for a set. Each is nil when it was not
/// said; the parser never fills a slot from a guess.
public struct SpokenValues: Codable, Equatable, Sendable {
    public var weight: SpokenWeight?
    public var reps: Int?
    public var durationSeconds: Int?
    /// Already snapped to a half step within 1–10 (`SetMetadata.parseRpe`).
    public var rpe: Double?
    public var isWarmup: Bool

    public init(weight: SpokenWeight? = nil, reps: Int? = nil, durationSeconds: Int? = nil, rpe: Double? = nil, isWarmup: Bool = false) {
        self.weight = weight
        self.reps = reps
        self.durationSeconds = durationSeconds
        self.rpe = rpe
        self.isWarmup = isWarmup
    }

    /// Weight, reps, duration or a rating: what makes an utterance a set worth
    /// logging. A warm-up flag or a set count alone is not one.
    public var hasAnyValue: Bool { weight != nil || reps != nil || durationSeconds != nil || rpe != nil }

    private enum CodingKeys: String, CodingKey { case weight, reps, durationSeconds, rpe, isWarmup }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weight = try c.decodeIfPresent(SpokenWeight.self, forKey: .weight)
        reps = try c.decodeIfPresent(Int.self, forKey: .reps)
        durationSeconds = try c.decodeIfPresent(Int.self, forKey: .durationSeconds)
        rpe = try c.decodeIfPresent(Double.self, forKey: .rpe)
        isWarmup = try c.decodeIfPresent(Bool.self, forKey: .isWarmup) ?? false
    }
}

/// What the athlete wants done: log `sets` rows of `values`, or repeat the
/// last logged set ("again", "same").
public enum SpokenIntent: Equatable, Sendable {
    case log(sets: Int, values: SpokenValues)
    case `repeat`
}

/// Which exercise the utterance names, resolved the way the picker resolves
/// (`NearMatch`) but on `voiceKey`s, which carry no punctuation or plural:
/// speech has neither. Only `.current` and a session `.resolved` are applied
/// without asking; everything else is the UI's question to put.
public enum SpokenExercise: Equatable, Sendable {
    public enum Scope: String, Codable, Sendable { case session, library }
    public enum Match: String, Codable, Sendable { case exact, contained, near }

    public struct Candidate: Codable, Equatable, Sendable {
        public var scope: Scope
        public var id: String
        public var name: String
        public var match: Match
        /// `NearMatch.distance` for a near candidate; 0 for exact and contained.
        public var distance: Int

        public init(scope: Scope, id: String, name: String, match: Match, distance: Int) {
            self.scope = scope
            self.id = id
            self.name = name
            self.match = match
            self.distance = distance
        }
    }

    /// No exercise was named: the set belongs to the exercise the tracker is on.
    case current
    /// One exercise, by an exact key or by containment (`match`). A session
    /// hit is applied at once; a library hit asks first in v1 (D-059).
    case resolved(scope: Scope, id: String, name: String, match: Match)
    /// Several could be meant, or only a typo-distance one: chips.
    case needsConfirmation(phrase: String, candidates: [Candidate])
    /// Nothing in today's session or the library: the picker, seeded with the phrase.
    case unresolved(phrase: String)
}

/// Why an utterance did not become a clean set. Every problem but the two
/// soft ones makes the parse `invalid`.
public enum SpokenProblem: String, Codable, Sendable, CaseIterable {
    case duplicateWeight, duplicateReps, duplicateDuration
    case setsOutOfRange, tooManyNumbers, ambiguousNumbers, repsNotInteger
    /// A rating outside 1–10 is dropped; the set stands.
    case rpeOutOfRange
    /// Two small bare numbers were read as reps then weight — logged, flagged.
    case barePair

    public var invalidates: Bool {
        switch self {
        case .rpeOutOfRange, .barePair: false
        default: true
        }
    }
}

/// The parser's answer for one transcript (or the best of several alternatives).
public struct SpokenParse: Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case ok, empty, invalid }

    public var status: Status
    /// The alternative that was chosen, verbatim.
    public var transcript: String
    /// Its index in the alternatives handed to `parse(alternatives:context:)`.
    public var chosen: Int
    /// Nil unless `status` is `ok`.
    public var intent: SpokenIntent?
    public var exercise: SpokenExercise
    /// Words no rule consumed, in order — never fatal, each costs a little score.
    public var ignored: [String]
    public var problems: [SpokenProblem]
    public var score: Int
    /// The slot rules (R1–R17) that fired, for the fixture's trace and the journal.
    public var rules: Set<String>
}

/// One set-tracked exercise in today's session, as the parser needs it: its
/// names resolve the phrase and its `fields` are the hint that reads a bare
/// number ("plank 60" is a duration, "bench 225" a weight).
public struct VoiceSessionExercise: Equatable, Sendable {
    public var id: String
    public var section: String
    public var name: String
    public var definitionId: String?
    public var fields: [SetField]

    public init(id: String, section: String, name: String, definitionId: String? = nil, fields: [SetField]) {
        self.id = id
        self.section = section
        self.name = name
        self.definitionId = definitionId
        self.fields = fields
    }
}

/// Everything the parser reads besides the transcript: the profile's weight
/// unit, today's set-tracked exercises, which one the tracker is on, and the
/// cached library (with aliases) for names not in the session.
public struct VoiceContext: Equatable, Sendable {
    public var unit: Weight.Unit?
    public var session: [VoiceSessionExercise]
    public var currentExerciseId: String?
    public var library: [ExerciseDefinition]

    public init(unit: Weight.Unit?, session: [VoiceSessionExercise], currentExerciseId: String?, library: [ExerciseDefinition]) {
        self.unit = unit
        self.session = session
        self.currentExerciseId = currentExerciseId
        self.library = library
    }

    /// The exercise the tracker is on, when it is one the parser knows.
    public var currentExercise: VoiceSessionExercise? {
        guard let currentExerciseId else { return nil }
        return session.first { $0.id == currentExerciseId }
    }
}

/// `Weight.Unit` on the wire ("lb" / "kg"): the fixture and the journal spell
/// units this way. Declared here so `Weight.swift` stays the web port it is.
extension Weight.Unit: Codable {}
