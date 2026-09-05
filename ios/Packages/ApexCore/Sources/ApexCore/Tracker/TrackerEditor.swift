import Foundation

/// In-memory edits to a server-built tracker model (architecture.md §7). The
/// server builds `groups` (plan × saved rows × shadows — D-008); this owns what
/// changes between saves: typed values, shadow commits, extra sets, swaps, and
/// the dirty keys that become the next `save`. Mirrors the mutation half of
/// `useWorkoutSession.ts` and the edit-related cases of plan.ts, and is a value
/// type so every rule is provable on Linux.
public struct TrackerEditor: Sendable, Equatable {
    public let session: SessionKey
    public private(set) var groups: [TrackedSectionGroup]
    public private(set) var dirtySets: Set<SetKey> = []
    public private(set) var dirtyCardio: Set<CardioKey> = []
    public private(set) var removedSets: [SetKey] = []

    public init(groups: [TrackedSectionGroup], session: SessionKey) {
        self.groups = groups
        self.session = session
    }

    public init(bootstrap: TrackerBootstrap, session: SessionKey) {
        self.init(groups: bootstrap.groups, session: session)
    }

    public var isDirty: Bool { !dirtySets.isEmpty || !dirtyCardio.isEmpty || !removedSets.isEmpty }

    // MARK: - Lookup

    private func locate(section: String, exerciseId: String) -> (group: Int, exercise: Int)? {
        for (g, group) in groups.enumerated() where group.section == section {
            if let e = group.exercises.firstIndex(where: { $0.exercise.id == exerciseId }) { return (g, e) }
        }
        return nil
    }

    private func locate(_ key: SetKey) -> (group: Int, exercise: Int, set: Int)? {
        guard let (g, e) = locate(section: key.section, exerciseId: key.exerciseId),
              let s = groups[g].exercises[e].sets.firstIndex(where: { $0.setNumber == key.setNumber })
        else { return nil }
        return (g, e, s)
    }

    public func exercise(section: String, id: String) -> TrackedExercise? {
        locate(section: section, exerciseId: id).map { groups[$0.group].exercises[$0.exercise] }
    }

    public func set(at key: SetKey) -> TrackedSet? {
        locate(key).map { groups[$0.group].exercises[$0.exercise].sets[$0.set] }
    }

    // MARK: - Set edits

    /// Every keystroke marks the set dirty (there is no blur gate on the web
    /// either); the debounce that turns dirty keys into a `save` is the model's.
    @discardableResult
    public mutating func setValue(_ value: String, _ field: SetField, at key: SetKey) -> Bool {
        guard let (g, e, s) = locate(key) else { return false }
        groups[g].exercises[e].sets[s][field] = value
        dirtySets.insert(key)
        return true
    }

    /// First focus anywhere in a shadowed row commits the whole row — but only
    /// the fields the row actually rendered, so a hidden shadow dimension can
    /// never leak into the log. Returns false when there was nothing to commit.
    @discardableResult
    public mutating func commitShadow(at key: SetKey, fields: [SetField]) -> Bool {
        guard let (g, e, s) = locate(key), let shadow = groups[g].exercises[e].sets[s].shadow else { return false }
        for field in fields {
            groups[g].exercises[e].sets[s][field] = shadow[field]
        }
        groups[g].exercises[e].sets[s].shadow = nil
        dirtySets.insert(key)
        return true
    }

    /// U28's one-tap "use last": commit every shadowed set of one exercise.
    /// Returns how many rows it committed.
    @discardableResult
    public mutating func commitAllShadows(section: String, exerciseId: String, fields: [SetField]) -> Int {
        guard let tracked = exercise(section: section, id: exerciseId) else { return 0 }
        var count = 0
        for set in tracked.sets where set.shadow != nil {
            if commitShadow(at: SetKey(section: section, exerciseId: exerciseId, setNumber: set.setNumber), fields: fields) {
                count += 1
            }
        }
        return count
    }

    // MARK: - Cardio edits

    @discardableResult
    public mutating func setCardio(_ value: String, _ field: CardioField, at key: CardioKey) -> Bool {
        guard let (g, e) = locate(section: key.section, exerciseId: key.exerciseId),
              groups[g].exercises[e].cardio != nil else { return false }
        groups[g].exercises[e].cardio?[field] = value
        dirtyCardio.insert(key)
        return true
    }

    /// Cardio ghosts commit per field: the four metrics are independent enough
    /// that one tap should not claim all of them. The other ghosts stay visible.
    @discardableResult
    public mutating func commitCardioShadow(_ field: CardioField, at key: CardioKey) -> Bool {
        guard let (g, e) = locate(section: key.section, exerciseId: key.exerciseId),
              let shadow = groups[g].exercises[e].cardio?.shadow, !shadow[field].isEmpty
        else { return false }
        groups[g].exercises[e].cardio?[field] = shadow[field]
        groups[g].exercises[e].cardio?.shadow?[field] = ""
        dirtyCardio.insert(key)
        return true
    }

    // MARK: - Extra sets

    /// Numbering continues from the current highest set — including hydrated
    /// extras — and never reuses a gap. An empty extra set is not dirty: it has
    /// nothing to persist until something is typed into it (web parity).
    @discardableResult
    public mutating func addExtraSet(section: String, exerciseId: String) -> Int? {
        guard let (g, e) = locate(section: section, exerciseId: exerciseId) else { return nil }
        let next = (groups[g].exercises[e].sets.map(\.setNumber).max() ?? 0) + 1
        groups[g].exercises[e].sets.append(TrackedSet(setNumber: next, planned: PlannedSet(setNumber: next), isExtra: true))
        return next
    }

    /// Only extras can go. The pending upsert for the key is dropped *before*
    /// the removal is recorded, so one `save` never carries both — the server
    /// runs upserts and deletes in one un-ordered batch.
    @discardableResult
    public mutating func removeExtraSet(at key: SetKey) -> Bool {
        guard let (g, e, s) = locate(key), groups[g].exercises[e].sets[s].isExtra else { return false }
        groups[g].exercises[e].sets.remove(at: s)
        dirtySets.remove(key)
        if !removedSets.contains(key) { removedSets.append(key) }
        return true
    }

    // MARK: - Swap

    /// Relabel a logged exercise onto the movement actually performed. The
    /// entry id never moves; `substitutedFrom` always names the *planned*
    /// movement across repeated swaps, and swapping back to it clears the note.
    @discardableResult
    public mutating func swap(section: String, exerciseId: String, toName: String, definitionId: String?) -> Bool {
        guard let (g, e) = locate(section: section, exerciseId: exerciseId) else { return false }
        let from = groups[g].exercises[e].substitutedFrom ?? groups[g].exercises[e].exercise.name
        groups[g].exercises[e].exercise.name = toName
        groups[g].exercises[e].exercise.definitionId = definitionId
        groups[g].exercises[e].substitutedFrom = from == toName ? nil : from
        return true
    }

    /// Whether the exercise carries any actual — saved or typed this sitting
    /// (`hasLoggedData`).
    public func hasLoggedData(section: String, exerciseId: String) -> Bool {
        guard let tracked = exercise(section: section, id: exerciseId) else { return false }
        if let cardio = tracked.cardio {
            return CardioField.allCases.contains { !cardio[$0].isEmpty }
        }
        return tracked.sets.contains(where: \.hasAnyActual)
    }

    /// Raised only after a swap onto a unilateral movement whose reps do not
    /// state the side convention — a planned unilateral entry already says so
    /// in its prescription, and repeating it would nag.
    public func needsPerSideWarning(section: String, exerciseId: String, swappedTo: ExerciseDefinition?) -> Bool {
        guard let tracked = exercise(section: section, id: exerciseId), tracked.substitutedFrom != nil,
              let swappedTo, swappedTo.isUnilateral == true
        else { return false }
        return tracked.sets.contains { !$0[.reps].isEmpty && !CountSpec.hasPerSideCount($0[.reps]) }
    }

    /// Which actual inputs an exercise gets (`inputFields` in TrackerExercise.tsx):
    /// the union of its planned targets, of whatever already carries a value,
    /// and — once swapped — of what the replacement is normally logged in. Reps
    /// is the fallback so every set has something to log. A climbing pitch logs
    /// exactly one thing: the grade, stored in the weight column.
    public static func inputFields(for tracked: TrackedExercise, swappedTo: ExerciseDefinition?) -> [SetField] {
        if tracked.exercise.category == "climbing" { return [.weight] }
        var fields = Set<SetField>()
        for set in tracked.sets {
            if let p = set.planned {
                if p.targetWeight?.isEmpty == false { fields.insert(.weight) }
                if p.targetReps?.isEmpty == false { fields.insert(.reps) }
                if p.targetDuration?.isEmpty == false { fields.insert(.duration) }
            }
            for field in SetField.allCases where !set[field].isEmpty { fields.insert(field) }
        }
        if tracked.substitutedFrom != nil {
            if swappedTo?.defaultDuration?.isEmpty == false { fields.insert(.duration) }
            if swappedTo?.defaultWeight?.isEmpty == false || swappedTo?.category == "strength" || swappedTo == nil {
                fields.insert(.weight)
            }
            if swappedTo?.defaultReps?.isEmpty == false || swappedTo?.category == "strength" || swappedTo == nil {
                fields.insert(.reps)
            }
        }
        if fields.isEmpty { fields.insert(.reps) }
        return SetField.allCases.filter(fields.contains)
    }

    // MARK: - Replay and refresh

    /// Replay a queued (unsent) save onto the groups — what an offline relaunch
    /// does before rendering, so the screen shows the edits the server has not
    /// seen yet. Rows for unknown set numbers become extras, exactly as the
    /// server would hydrate them once the save lands.
    public mutating func apply(_ payload: SavePayload) {
        for key in payload.removedSets {
            if let (g, e, s) = locate(key) { groups[g].exercises[e].sets.remove(at: s) }
        }
        for row in payload.setLogs {
            guard let (g, e) = locate(section: row.section, exerciseId: row.exerciseId) else { continue }
            if let s = groups[g].exercises[e].sets.firstIndex(where: { $0.setNumber == row.setNumber }) {
                var set = groups[g].exercises[e].sets[s]
                set.actualWeight = row.actualWeight ?? ""
                set.actualReps = row.actualReps ?? ""
                set.actualDuration = row.actualDuration ?? ""
                set.isLogged = true
                set.isAutofilled = row.isAutofilled
                set.shadow = nil
                groups[g].exercises[e].sets[s] = set
            } else {
                groups[g].exercises[e].sets.append(TrackedSet(
                    setNumber: row.setNumber,
                    planned: PlannedSet(
                        setNumber: row.setNumber, targetWeight: row.plannedWeight,
                        targetReps: row.plannedReps, targetDuration: row.plannedDuration
                    ),
                    actualWeight: row.actualWeight ?? "", actualReps: row.actualReps ?? "",
                    actualDuration: row.actualDuration ?? "", isLogged: true,
                    isAutofilled: row.isAutofilled, isExtra: true
                ))
                groups[g].exercises[e].sets.sort { $0.setNumber < $1.setNumber }
            }
        }
        for row in payload.cardioLogs {
            guard let (g, e) = locate(section: row.section, exerciseId: row.exerciseId),
                  groups[g].exercises[e].cardio != nil else { continue }
            groups[g].exercises[e].cardio?.durationMinutes = row.durationMinutes.map(Self.decimalText) ?? ""
            groups[g].exercises[e].cardio?.distance = row.distance ?? ""
            groups[g].exercises[e].cardio?.elevationGain = row.elevationGain ?? ""
            groups[g].exercises[e].cardio?.avgHeartRate = row.avgHeartRate.map(String.init) ?? ""
            groups[g].exercises[e].cardio?.isLogged = true
            groups[g].exercises[e].cardio?.shadow = nil
        }
    }

    /// The render-first flow: a fresh server model replaces the cached one only
    /// when nothing local is ahead of it. With dirty keys or unsent ops the
    /// local state already equals server state plus our own writes, and taking
    /// the server's copy would erase them.
    @discardableResult
    public mutating func replaceGroupsIfClean(_ fresh: [TrackedSectionGroup], queueHasPending: Bool) -> Bool {
        guard !isDirty, !queueHasPending else { return false }
        groups = fresh
        return true
    }

    // MARK: - Finish

    /// Planned sets never logged nor edited this sitting — zero-filled at
    /// Finish, `is_autofilled` so analytics can tell a skipped set from a real
    /// 0-rep attempt. A ghost never tapped is a skipped set. Never extras.
    public func collectUntouchedPlanned() -> [SetLogRow] {
        var rows: [SetLogRow] = []
        for group in groups {
            for tracked in group.exercises {
                for set in tracked.sets where !set.isExtra && !set.isLogged && !set.hasAnyActual {
                    var row = Self.setToRow(session: session, tracked: tracked, set: set)
                    let plannedWeight = row.plannedWeight?.isEmpty == false
                    let plannedReps = row.plannedReps?.isEmpty == false
                    let plannedDuration = row.plannedDuration?.isEmpty == false
                    row.actualWeight = plannedWeight ? "0" : nil
                    row.actualReps = plannedReps || !plannedDuration ? "0" : nil
                    row.actualDuration = plannedDuration ? "0" : nil
                    row.isAutofilled = true
                    rows.append(row)
                }
            }
        }
        return rows
    }

    public var unloggedPlannedCount: Int { collectUntouchedPlanned().count }

    // MARK: - Serialisation

    /// Everything dirty, as one `save`, then nothing is dirty. Keys are sorted
    /// so the same edits always produce the same bytes. Nil when clean. The
    /// caller hands the payload to the write queue *before* anything else
    /// happens — unlike the web, which clears its dirty keys and then awaits
    /// the network, losing the batch if the request fails.
    public mutating func takeSavePayload() -> SavePayload? {
        var setLogs: [SetLogRow] = []
        for key in dirtySets.sorted(by: Self.orderKeys) {
            guard let (g, e, s) = locate(key) else { continue }
            let tracked = groups[g].exercises[e]
            setLogs.append(Self.setToRow(session: session, tracked: tracked, set: tracked.sets[s]))
        }
        var cardioLogs: [CardioLogRow] = []
        for key in dirtyCardio.sorted(by: Self.orderKeys) {
            guard let (g, e) = locate(section: key.section, exerciseId: key.exerciseId),
                  groups[g].exercises[e].cardio != nil else { continue }
            cardioLogs.append(Self.cardioToRow(session: session, tracked: groups[g].exercises[e]))
        }
        let payload = SavePayload(setLogs: setLogs, cardioLogs: cardioLogs, removedSets: removedSets)
        dirtySets = []
        dirtyCardio = []
        removedSets = []
        return payload.isEmpty ? nil : payload
    }

    /// `setToRow`: planned targets snapshotted, empty actuals as null, the
    /// substituted name and definition (the model already swapped them in).
    public static func setToRow(session: SessionKey, tracked: TrackedExercise, set: TrackedSet) -> SetLogRow {
        SetLogRow(
            eventId: session.eventId, eventDate: session.eventDate, section: tracked.section,
            exerciseId: tracked.exercise.id, exerciseName: tracked.exercise.name,
            definitionId: tracked.exercise.definitionId, setNumber: set.setNumber,
            plannedWeight: nonEmpty(set.planned?.targetWeight), plannedReps: nonEmpty(set.planned?.targetReps),
            plannedDuration: nonEmpty(set.planned?.targetDuration),
            actualWeight: nonEmpty(set.actualWeight), actualReps: nonEmpty(set.actualReps),
            actualDuration: nonEmpty(set.actualDuration), isAutofilled: false
        )
    }

    /// `cardioToRow`: `duration_minutes` parsed as a number, `avg_heart_rate`
    /// as an integer (null when not parseable), blanks as null.
    public static func cardioToRow(session: SessionKey, tracked: TrackedExercise) -> CardioLogRow {
        let cardio = tracked.cardio ?? CardioLog()
        return CardioLogRow(
            eventId: session.eventId, eventDate: session.eventDate, section: tracked.section,
            exerciseId: tracked.exercise.id, exerciseName: tracked.exercise.name,
            definitionId: tracked.exercise.definitionId,
            durationMinutes: leadingDouble(cardio.durationMinutes),
            distance: nonEmpty(cardio.distance), elevationGain: nonEmpty(cardio.elevationGain),
            avgHeartRate: leadingInt(cardio.avgHeartRate), isAutofilled: false
        )
    }

    /// Every input on the screen in reading order, for Next/Done focus advance.
    /// `visible` says which set fields an exercise renders (`inputFields`).
    public func fieldOrder(visible: (TrackedExercise) -> [SetField]) -> [FieldID] {
        var order: [FieldID] = []
        for group in groups {
            for tracked in group.exercises {
                let key = CardioKey(section: tracked.section, exerciseId: tracked.exercise.id)
                if tracked.cardio != nil {
                    order += CardioField.allCases.map { FieldID.cardio(key, $0) }
                    continue
                }
                let fields = visible(tracked)
                for set in tracked.sets {
                    let setKey = SetKey(section: tracked.section, exerciseId: tracked.exercise.id, setNumber: set.setNumber)
                    order += fields.map { FieldID.set(setKey, $0) }
                }
            }
        }
        return order
    }

    // MARK: - Helpers

    private static func orderKeys(_ a: SetKey, _ b: SetKey) -> Bool {
        (a.section, a.exerciseId, a.setNumber) < (b.section, b.exerciseId, b.setNumber)
    }

    private static func orderKeys(_ a: CardioKey, _ b: CardioKey) -> Bool {
        (a.section, a.exerciseId) < (b.section, b.exerciseId)
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// JavaScript's `parseFloat`: the leading number, or nil.
    static func leadingDouble(_ s: String?) -> Double? {
        guard let s else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        var text = ""
        var seenDot = false
        for c in trimmed {
            if c.isNumber, c.isASCII { text.append(c) }
            else if c == ".", !seenDot { seenDot = true; text.append(c) }
            else if c == "-", text.isEmpty { text.append(c) }
            else { break }
        }
        return Double(text)
    }

    /// JavaScript's `parseInt(x, 10)`: the leading integer, or nil.
    static func leadingInt(_ s: String?) -> Int? {
        guard let s else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        var text = ""
        for c in trimmed {
            if c.isNumber, c.isASCII { text.append(c) }
            else if c == "-", text.isEmpty { text.append(c) }
            else { break }
        }
        return Int(text)
    }

    /// 42.5 → "42.5", 45 → "45" — the way the web's text field shows a saved number.
    static func decimalText(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }
}
