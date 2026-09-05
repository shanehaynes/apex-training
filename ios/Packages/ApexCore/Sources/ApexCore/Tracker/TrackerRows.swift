import Foundation

/// The rows `POST /api/workout-sessions { action: "save" }` upserts. Field sets
/// are the server's allowlists (`SET_LOG_COLUMNS` / `CARDIO_LOG_COLUMNS` in
/// api/_lib/allowlist.ts): an unknown key is a 400, so nothing else may be
/// encoded here; `id`, `user_id` and the timestamps are server-stamped and not
/// sent. Optionals encode as explicit `null` to match the web's rows
/// (`setToRow` / `cardioToRow` in src/lib/tracking/plan.ts).
public struct SetLogRow: Codable, Sendable, Equatable {
    public var eventId: String
    public var eventDate: String
    public var section: String
    public var exerciseId: String
    public var exerciseName: String
    public var definitionId: String?
    public var setNumber: Int
    public var plannedWeight: String?
    public var plannedReps: String?
    public var plannedDuration: String?
    public var actualWeight: String?
    public var actualReps: String?
    public var actualDuration: String?
    public var isAutofilled: Bool

    public init(
        eventId: String, eventDate: String, section: String, exerciseId: String, exerciseName: String,
        definitionId: String? = nil, setNumber: Int,
        plannedWeight: String? = nil, plannedReps: String? = nil, plannedDuration: String? = nil,
        actualWeight: String? = nil, actualReps: String? = nil, actualDuration: String? = nil,
        isAutofilled: Bool = false
    ) {
        self.eventId = eventId
        self.eventDate = eventDate
        self.section = section
        self.exerciseId = exerciseId
        self.exerciseName = exerciseName
        self.definitionId = definitionId
        self.setNumber = setNumber
        self.plannedWeight = plannedWeight
        self.plannedReps = plannedReps
        self.plannedDuration = plannedDuration
        self.actualWeight = actualWeight
        self.actualReps = actualReps
        self.actualDuration = actualDuration
        self.isAutofilled = isAutofilled
    }

    public var key: SetKey { SetKey(section: section, exerciseId: exerciseId, setNumber: setNumber) }

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case eventDate = "event_date"
        case section
        case exerciseId = "exercise_id"
        case exerciseName = "exercise_name"
        case definitionId = "definition_id"
        case setNumber = "set_number"
        case plannedWeight = "planned_weight"
        case plannedReps = "planned_reps"
        case plannedDuration = "planned_duration"
        case actualWeight = "actual_weight"
        case actualReps = "actual_reps"
        case actualDuration = "actual_duration"
        case isAutofilled = "is_autofilled"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(eventId, forKey: .eventId)
        try c.encode(eventDate, forKey: .eventDate)
        try c.encode(section, forKey: .section)
        try c.encode(exerciseId, forKey: .exerciseId)
        try c.encode(exerciseName, forKey: .exerciseName)
        try c.encode(definitionId, forKey: .definitionId)
        try c.encode(setNumber, forKey: .setNumber)
        try c.encode(plannedWeight, forKey: .plannedWeight)
        try c.encode(plannedReps, forKey: .plannedReps)
        try c.encode(plannedDuration, forKey: .plannedDuration)
        try c.encode(actualWeight, forKey: .actualWeight)
        try c.encode(actualReps, forKey: .actualReps)
        try c.encode(actualDuration, forKey: .actualDuration)
        try c.encode(isAutofilled, forKey: .isAutofilled)
    }
}

public struct CardioLogRow: Codable, Sendable, Equatable {
    public var eventId: String
    public var eventDate: String
    public var section: String
    public var exerciseId: String
    public var exerciseName: String
    public var definitionId: String?
    public var durationMinutes: Double?
    public var distance: String?
    public var elevationGain: String?
    public var avgHeartRate: Int?
    public var isAutofilled: Bool

    public init(
        eventId: String, eventDate: String, section: String, exerciseId: String, exerciseName: String,
        definitionId: String? = nil, durationMinutes: Double? = nil, distance: String? = nil,
        elevationGain: String? = nil, avgHeartRate: Int? = nil, isAutofilled: Bool = false
    ) {
        self.eventId = eventId
        self.eventDate = eventDate
        self.section = section
        self.exerciseId = exerciseId
        self.exerciseName = exerciseName
        self.definitionId = definitionId
        self.durationMinutes = durationMinutes
        self.distance = distance
        self.elevationGain = elevationGain
        self.avgHeartRate = avgHeartRate
        self.isAutofilled = isAutofilled
    }

    public var key: CardioKey { CardioKey(section: section, exerciseId: exerciseId) }

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case eventDate = "event_date"
        case section
        case exerciseId = "exercise_id"
        case exerciseName = "exercise_name"
        case definitionId = "definition_id"
        case durationMinutes = "duration_minutes"
        case distance
        case elevationGain = "elevation_gain"
        case avgHeartRate = "avg_heart_rate"
        case isAutofilled = "is_autofilled"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(eventId, forKey: .eventId)
        try c.encode(eventDate, forKey: .eventDate)
        try c.encode(section, forKey: .section)
        try c.encode(exerciseId, forKey: .exerciseId)
        try c.encode(exerciseName, forKey: .exerciseName)
        try c.encode(definitionId, forKey: .definitionId)
        try c.encode(durationMinutes, forKey: .durationMinutes)
        try c.encode(distance, forKey: .distance)
        try c.encode(elevationGain, forKey: .elevationGain)
        try c.encode(avgHeartRate, forKey: .avgHeartRate)
        try c.encode(isAutofilled, forKey: .isAutofilled)
    }
}

/// One `save`: everything touched since the last one. The server upserts the
/// logs and deletes `removedSets` in one un-ordered batch, so a key must never
/// appear in both lists — `TrackerEditor` keeps that true within a payload and
/// `merging` keeps it true across them.
public struct SavePayload: Codable, Sendable, Equatable {
    /// The server rejects a list past this (`MAX_BATCH_ROWS`).
    public static let serverRowCap = 500

    public var setLogs: [SetLogRow]
    public var cardioLogs: [CardioLogRow]
    public var removedSets: [SetKey]

    public init(setLogs: [SetLogRow] = [], cardioLogs: [CardioLogRow] = [], removedSets: [SetKey] = []) {
        self.setLogs = setLogs
        self.cardioLogs = cardioLogs
        self.removedSets = removedSets
    }

    public var isEmpty: Bool { setLogs.isEmpty && cardioLogs.isEmpty && removedSets.isEmpty }
    public var exceedsServerCap: Bool {
        setLogs.count > Self.serverRowCap || cardioLogs.count > Self.serverRowCap || removedSets.count > Self.serverRowCap
    }

    /// Every set this payload touches — upserts and deletes alike.
    public var setKeys: Set<SetKey> { Set(setLogs.map(\.key)).union(removedSets) }
    public var cardioKeys: Set<CardioKey> { Set(cardioLogs.map(\.key)) }

    /// `self` happened first, `later` second. Last write per key wins; a later
    /// removal drops the earlier upsert of that key, a later upsert revives a
    /// key the earlier payload removed. The result is one envelope that lands
    /// the same end state as sending both — which is what lets a long offline
    /// session leave a short queue (architecture.md §7).
    public func merging(_ later: SavePayload) -> SavePayload {
        var sets = setLogs
        var removed = removedSets
        var cardio = cardioLogs

        for key in later.removedSets {
            sets.removeAll { $0.key == key }
            if !removed.contains(key) { removed.append(key) }
        }
        for row in later.setLogs {
            removed.removeAll { $0 == row.key }
            if let i = sets.firstIndex(where: { $0.key == row.key }) {
                sets[i] = row
            } else {
                sets.append(row)
            }
        }
        for row in later.cardioLogs {
            if let i = cardio.firstIndex(where: { $0.key == row.key }) {
                cardio[i] = row
            } else {
                cardio.append(row)
            }
        }
        return SavePayload(setLogs: sets, cardioLogs: cardio, removedSets: removed)
    }
}

/// The score the finish gate collects for a `for-time` / `amrap` template
/// (`ScorePrompt.tsx`). Encodes flat, the way the handler reads it:
/// `{ templateId, type, timeSeconds }` or `{ templateId, type, rounds, reps }`.
public struct ScoreSubmission: Codable, Sendable, Equatable {
    public var templateId: String
    public var score: SessionScore

    public init(templateId: String, score: SessionScore) {
        self.templateId = templateId
        self.score = score
    }

    private enum CodingKeys: String, CodingKey { case templateId, type, timeSeconds, rounds, reps }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(templateId, forKey: .templateId)
        try c.encode(score.type, forKey: .type)
        switch score {
        case .forTime(let timeSeconds):
            try c.encode(timeSeconds, forKey: .timeSeconds)
        case .amrap(let rounds, let reps):
            try c.encode(rounds, forKey: .rounds)
            try c.encode(reps, forKey: .reps)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        templateId = try c.decode(String.self, forKey: .templateId)
        guard let score = SessionScore(
            scoreType: try c.decode(String.self, forKey: .type),
            timeSeconds: try c.decodeIfPresent(Int.self, forKey: .timeSeconds),
            rounds: try c.decodeIfPresent(Int.self, forKey: .rounds),
            reps: try c.decodeIfPresent(Int.self, forKey: .reps)
        ) else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "not a session score")
        }
        self.score = score
    }
}

/// `finish`: the zero-fills for planned sets never touched, when it really
/// ended (ISO, for a flush that lands late), and the optional score.
public struct FinishPayload: Codable, Sendable, Equatable {
    public var autofillRows: [SetLogRow]
    public var finishedAt: String?
    public var score: ScoreSubmission?

    public init(autofillRows: [SetLogRow], finishedAt: String?, score: ScoreSubmission? = nil) {
        self.autofillRows = autofillRows
        self.finishedAt = finishedAt
        self.score = score
    }
}

/// `swap-exercise`: relabel one logged exercise onto another definition. The
/// `exerciseId` never changes — every row keys on it; only the name and
/// definition move, and only on the rows, never on the plan.
public struct SwapPayload: Codable, Sendable, Equatable {
    public var section: String
    public var exerciseId: String
    public var exerciseName: String
    public var definitionId: String?

    public init(section: String, exerciseId: String, exerciseName: String, definitionId: String?) {
        self.section = section
        self.exerciseId = exerciseId
        self.exerciseName = exerciseName
        self.definitionId = definitionId
    }
}
