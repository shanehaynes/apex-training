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
        guard let (g, e, s) = locate(key) else { return false }
        let set = groups[g].exercises[e].sets[s]
        guard set.shadow != nil else { return false }
        for field in fields {
            groups[g].exercises[e].sets[s][field] = Self.ghost(of: set, field: field)
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
        // An added exercise is nothing but its sets: the last one takes it along.
        if groups[g].exercises[e].added, !groups[g].exercises[e].isCardio, groups[g].exercises[e].sets.isEmpty {
            dropExercise(group: g, exercise: e)
        }
        return true
    }

    // MARK: - Added exercises

    /// The prefix of an exercise added in the tracker (`ADDED_EXERCISE_PREFIX`).
    public static let addedPrefix = "added-"

    /// `newAddedExerciseId`: milliseconds, so additions order by when they were made.
    public static func addedExerciseId(at date: Date) -> String {
        "\(addedPrefix)\(Int64((date.timeIntervalSince1970 * 1000).rounded()))"
    }

    public static func isAddedExerciseId(_ id: String) -> Bool { id.hasPrefix(addedPrefix) }

    /// "Pushups weren't in today's plan" (`makeAddedExercise`): appended to the
    /// main section with one empty extra set, or an empty cardio form. Like any
    /// empty extra it is not dirty — nothing persists until a value is typed —
    /// and it lives on the log rows only, never on the plan.
    @discardableResult
    public mutating func addExercise(
        id: String, name: String, definitionId: String?, category: String?, sectionLabel: String
    ) -> TrackedExercise {
        let isCardio = category == "cardio"
        let tracked = TrackedExercise(
            section: Self.mainSection,
            exercise: Exercise(id: id, name: name, category: category, definitionId: definitionId),
            isCardio: isCardio,
            sets: isCardio ? [] : [TrackedSet(setNumber: 1, planned: PlannedSet(setNumber: 1), isExtra: true)],
            cardio: isCardio ? CardioLog() : nil,
            isAdded: true
        )
        insert(tracked, sectionLabel: sectionLabel)
        return tracked
    }

    /// Take an added exercise back out. Every set it has is removed — the
    /// server deletes its cardio row too, for any removed key naming an added
    /// id, which is what the set-number-0 key is for.
    @discardableResult
    public mutating func removeAddedExercise(section: String, exerciseId: String) -> Bool {
        guard let (g, e) = locate(section: section, exerciseId: exerciseId), groups[g].exercises[e].added else { return false }
        let tracked = groups[g].exercises[e]
        var keys = tracked.sets.map { SetKey(section: section, exerciseId: exerciseId, setNumber: $0.setNumber) }
        if tracked.isCardio { keys.append(SetKey(section: section, exerciseId: exerciseId, setNumber: 0)) }
        for key in keys {
            dirtySets.remove(key)
            if !removedSets.contains(key) { removedSets.append(key) }
        }
        dirtyCardio.remove(CardioKey(section: section, exerciseId: exerciseId))
        dropExercise(group: g, exercise: e)
        return true
    }

    private static let mainSection = "exercise"

    private static let sectionOrder = ["warmup", "exercise", "cooldown"]

    /// Into its section, opening it in plan order when the plan had none.
    private mutating func insert(_ tracked: TrackedExercise, sectionLabel: String) {
        if let g = groups.firstIndex(where: { $0.section == tracked.section }) {
            groups[g].exercises.append(tracked)
            return
        }
        let rank = { (section: String) in Self.sectionOrder.firstIndex(of: section) ?? Self.sectionOrder.count }
        let at = groups.firstIndex(where: { rank($0.section) > rank(tracked.section) }) ?? groups.endIndex
        groups.insert(TrackedSectionGroup(section: tracked.section, label: sectionLabel, exercises: [tracked]), at: at)
    }

    private mutating func dropExercise(group g: Int, exercise e: Int) {
        groups[g].exercises.remove(at: e)
        if groups[g].exercises.isEmpty { groups.remove(at: g) }
    }

    /// What a ghost tap commits into a field (`ghostOf`): last session's
    /// value — except the weight of a set whose percentage target resolved,
    /// which commits today's load with the unit it was resolved in, so what
    /// the plan asks for is stored whatever unit the profile says by then.
    public static func ghost(of set: TrackedSet, field: SetField) -> String {
        guard let shadow = set.shadow else { return "" }
        if field == .weight, let resolved = set.resolvedPlannedWeight, !resolved.isEmpty { return resolved }
        return shadow[field]
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
        // A resolved load is a percentage of the planned lift's max, not the
        // new movement's (`clearResolvedLoads`): the raw target shows until the
        // next bootstrap, swapping back included.
        for s in groups[g].exercises[e].sets.indices {
            groups[g].exercises[e].sets[s].resolvedPlannedWeight = nil
        }
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
        guard let tracked = exercise(section: section, id: exerciseId) else { return false }
        return Self.needsPerSideWarning(for: tracked, swappedTo: swappedTo)
    }

    /// The same question asked of an exercise already in hand — the tracker row
    /// has one, and looking it up in the editor again only made the row observe
    /// every other exercise's edits.
    public static func needsPerSideWarning(for tracked: TrackedExercise, swappedTo: ExerciseDefinition?) -> Bool {
        guard tracked.isOffPlan, let swappedTo, swappedTo.isUnilateral == true else { return false }
        return tracked.sets.contains { !$0[.reps].isEmpty && !CountSpec.hasPerSideCount($0[.reps]) }
    }

    /// Which actual inputs an exercise gets (`inputFields` in src/lib/tracking/fields.ts):
    /// the union of its planned targets, of whatever already carries a value, of the
    /// dimensions its library definition is always logged in (`log_fields`, plus any
    /// added this sitting before that write lands), and — once swapped or added — of
    /// what that movement is normally logged in. Reps is the fallback so every set has
    /// something to log. A climbing pitch logs exactly one thing: the grade, stored in
    /// the weight column.
    ///
    /// `definition` is the movement's library entry whenever the entry has one — on
    /// a planned exercise only its `logFields` are read; the default prescription is
    /// consulted only off-plan, where there is no prescription of its own to read.
    public static func inputFields(
        for tracked: TrackedExercise, definition: ExerciseDefinition?, addedHere: [SetField] = []
    ) -> [SetField] {
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
        for name in definition?.logFields ?? [] {
            if let field = SetField(logField: name) { fields.insert(field) }
        }
        fields.formUnion(addedHere)
        if tracked.isOffPlan {
            let swappedTo = definition
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

    /// The inputs an exercise does not have yet and could add mid-workout
    /// (`addable` in TrackerExercise.tsx). A pitch's one input is fixed.
    public static func addableFields(for tracked: TrackedExercise, fields: [SetField]) -> [SetField] {
        if tracked.exercise.category == "climbing" { return [] }
        return SetField.allCases.filter { !fields.contains($0) }
    }

    /// What a definition's `log_fields` become after adding `field` this sitting
    /// (`nextLogFields` in fields.ts): the stored set plus every field added here
    /// so far, not the stored set plus this one alone — so a write queued before
    /// the previous one has landed still carries it. Column order; a stored name
    /// outside the three columns is dropped (the table's CHECK refuses it anyway).
    public static func nextLogFields(stored: [String], addedHere: [SetField], adding field: SetField) -> [String] {
        let wanted = Set(stored.compactMap(SetField.init(logField:))).union(addedHere).union([field])
        return SetField.allCases.filter(wanted.contains).map(\.logField)
    }

    // MARK: - Replay and refresh

    /// Replay a queued (unsent) save onto the groups — what an offline relaunch
    /// does before rendering, so the screen shows the edits the server has not
    /// seen yet. Rows for unknown set numbers become extras, exactly as the
    /// server would hydrate them once the save lands.
    public mutating func apply(_ payload: SavePayload) {
        for key in payload.removedSets {
            if let (g, e, s) = locate(key) {
                groups[g].exercises[e].sets.remove(at: s)
                if groups[g].exercises[e].added, !groups[g].exercises[e].isCardio, groups[g].exercises[e].sets.isEmpty {
                    dropExercise(group: g, exercise: e)
                }
            } else if Self.isAddedExerciseId(key.exerciseId), let (g, e) = locate(section: key.section, exerciseId: key.exerciseId),
                      groups[g].exercises[e].isCardio {
                dropExercise(group: g, exercise: e)
            }
        }
        for row in payload.setLogs {
            if locate(section: row.section, exerciseId: row.exerciseId) == nil, Self.isAddedExerciseId(row.exerciseId) {
                insertAdded(section: row.section, exerciseId: row.exerciseId, name: row.exerciseName,
                            definitionId: row.definitionId, isCardio: false)
            }
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
            if locate(section: row.section, exerciseId: row.exerciseId) == nil, Self.isAddedExerciseId(row.exerciseId) {
                insertAdded(section: row.section, exerciseId: row.exerciseId, name: row.exerciseName,
                            definitionId: row.definitionId, isCardio: true)
            }
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

    /// A queued row for an added exercise the cached model has not seen yet —
    /// the shape the server rebuilds it in once the save lands.
    private mutating func insertAdded(section: String, exerciseId: String, name: String, definitionId: String?, isCardio: Bool) {
        let tracked = TrackedExercise(
            section: section,
            exercise: Exercise(id: exerciseId, name: name, category: isCardio ? "cardio" : "strength", definitionId: definitionId),
            isCardio: isCardio, sets: [], cardio: isCardio ? CardioLog() : nil, isAdded: true
        )
        insert(tracked, sectionLabel: Self.defaultLabels[section] ?? section)
    }

    /// `sectionLabels` for every type but outdoor climbing — only ever needed
    /// when an offline replay opens a section the cached model did not have.
    private static let defaultLabels = ["warmup": "Warm-Up", "exercise": "Main Work", "cooldown": "Cool-Down"]

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
