import ApexCore
import Foundation

/// The small pure helpers the exercise editor and picker share — the
/// `src/lib/schedule/definitions.ts` entry-authoring rules and the climbing
/// vocab from `src/lib/climbing.ts`. Form state only; the server re-letters
/// supersets and resolves names again on every write.
enum Entries {
    /// `normalize`: trim, collapse whitespace, lowercase.
    static func normalized(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    /// `matchDefinitionByName`: exact (case/whitespace-insensitive) against the
    /// canonical name and every alias — never fuzzy.
    static func match(_ name: String, in definitions: [ExerciseDefinition]) -> ExerciseDefinition? {
        let wanted = normalized(name)
        guard !wanted.isEmpty else { return nil }
        return definitions.first { definition in
            normalized(definition.canonicalName) == wanted || (definition.aliases ?? []).contains { normalized($0) == wanted }
        }
    }

    /// `uniqueEntryId`: `base`, then `base-2`, `base-3`, …
    static func uniqueId(_ base: String, taken: [String]) -> String {
        let used = Set(taken)
        guard used.contains(base) else { return base }
        var n = 2
        while used.contains("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }

    /// `entryFromDefinition`: the library's defaults become the prescription.
    static func entry(from definition: ExerciseDefinition, taken: [String]) -> Exercise {
        Exercise(
            id: uniqueId(definition.id, taken: taken), name: definition.canonicalName, category: definition.category,
            sets: definition.defaultSets, reps: definition.defaultReps, weight: definition.defaultWeight,
            duration: definition.defaultDuration, restPeriod: definition.defaultRest, definitionId: definition.id
        )
    }

    /// `addPitch`: a new pitch inherits the previous one's style.
    static func pitch(after previous: Exercise?, taken: [String]) -> Exercise {
        let style = previous?.climbStyle ?? "sport"
        return Exercise(id: uniqueId("pitch", taken: taken), name: climbStyleLabel(style), category: "climbing", climbStyle: style)
    }

    static let climbStyles: [(value: String, label: String)] = [
        ("sport", "Sport"), ("trad", "Trad"), ("boulder", "Boulder"), ("ice-mixed", "Ice/Mixed"),
    ]
    static let ascentStyles: [(value: String, label: String)] = [
        ("flash", "Flashed"), ("redpoint", "Redpointed"), ("follow", "Followed"), ("onsight", "Onsighted"), ("attempt", "Attempted"),
    ]

    static func climbStyleLabel(_ style: String?) -> String {
        climbStyles.first { $0.value == style }?.label ?? "Climb"
    }

    /// Boulders are never followed.
    static func ascentStyles(for style: String?) -> [(value: String, label: String)] {
        style == "boulder" ? ascentStyles.filter { $0.value != "follow" } : ascentStyles
    }

    /// The category chips the picker offers, in the web's order.
    static let categories: [(value: String, label: String)] = [
        ("strength", "Strength"), ("stretch", "Stretch"), ("mobility", "Mobility"), ("skill", "Skill"), ("cardio", "Cardio"), ("climbing", "Climbing"),
    ]

    /// `hasPerSideCount`: whether a count states its side convention.
    static func hasPerSideCount(_ text: String?) -> Bool {
        guard let text else { return false }
        let range = NSRange(text.startIndex..., in: text)
        return Self.perSide.firstMatch(in: text, range: range) != nil
    }
    private static let perSide = try! NSRegularExpression(pattern: #"\beach\b|\bper\s+(side|leg|arm)\b|\btotal\b"#, options: .caseInsensitive)

    /// `validateUnilateral`, for the instant per-card error; the server runs
    /// the same check before it writes.
    static func unilateralViolations(_ lists: WorkoutDraft.Sections, definitions: [ExerciseDefinition]) -> [String: String] {
        let byId = Dictionary(definitions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var out: [String: String] = [:]
        for entry in lists.warmup + lists.exercises + lists.cooldown {
            guard let definitionId = entry.definitionId, byId[definitionId]?.isUnilateral == true,
                  let counted = entry.reps ?? entry.duration, !counted.isEmpty, !hasPerSideCount(counted) else { continue }
            out[entry.id] = "Per-side count needed — e.g. \"\(counted) each side\" (or \"total\")."
        }
        return out
    }
}

/// Which list of a `WorkoutDraft.Sections` an editor row belongs to.
enum SectionKey: String, CaseIterable, Identifiable, Sendable {
    case warmup, exercises, cooldown
    var id: String { rawValue }

    var keyPath: WritableKeyPath<WorkoutDraft.Sections, [Exercise]> {
        switch self {
        case .warmup: \.warmup
        case .exercises: \.exercises
        case .cooldown: \.cooldown
        }
    }

    /// `sectionLabels`: outdoor climbing repurposes the three sections.
    func label(for type: WorkoutType) -> String {
        switch (self, type == .outdoorClimbing) {
        case (.warmup, true): "Approach"
        case (.exercises, true): "Pitches"
        case (.cooldown, true): "Descent"
        case (.warmup, false): "Warm-Up"
        case (.exercises, false): "Main Work"
        case (.cooldown, false): "Cool-Down"
        }
    }
}
