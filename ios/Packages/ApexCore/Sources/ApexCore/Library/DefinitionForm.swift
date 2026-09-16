import Foundation

/// The library editor's value type (`DefinitionEditor.tsx`): the definition's
/// fields as typed, and the diff a save sends. Like the web it PATCHes only
/// what changed — a rename travels alone as `canonical_name`, and the server
/// appends the old name as an alias so history follows it.
///
/// One improvement over the web: a default cleared in the editor is sent as
/// an explicit null and clears the column (the web drops the key and cannot).
public struct DefinitionForm: Sendable, Equatable {
    public var name: String
    public var category: String
    public var isUnilateral: Bool
    /// Comma-separated, as the web's fields are.
    public var muscleGroups: String
    public var equipment: String
    public var techniqueNotes: String
    public var defaultSets: String
    public var defaultReps: String
    public var defaultDuration: String
    public var defaultWeight: String
    public var defaultRest: String

    public static let categories = ["strength", "stretch", "mobility", "skill", "cardio", "climbing"]

    public init(definition d: ExerciseDefinition) {
        name = d.canonicalName
        category = d.category ?? "strength"
        isUnilateral = d.isUnilateral ?? false
        muscleGroups = (d.muscleGroups ?? []).joined(separator: ", ")
        equipment = (d.equipment ?? []).joined(separator: ", ")
        techniqueNotes = d.techniqueNotes ?? ""
        defaultSets = d.defaultSets.map(String.init) ?? ""
        defaultReps = d.defaultReps ?? ""
        defaultDuration = d.defaultDuration ?? ""
        defaultWeight = d.defaultWeight ?? ""
        defaultRest = d.defaultRest ?? ""
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    /// True when the save would rename — the editor shows the alias hint.
    public func isRenaming(_ d: ExerciseDefinition) -> Bool {
        !trimmedName.isEmpty && trimmedName != d.canonicalName
    }

    /// The `fields` of the PATCH: only columns whose value differs from the
    /// definition's. Empty when nothing changed (the editor just closes).
    public func changedFields(against d: ExerciseDefinition) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if isRenaming(d) { out["canonical_name"] = .string(trimmedName) }
        if category != (d.category ?? "") { out["category"] = .string(category) }
        if isUnilateral != (d.isUnilateral ?? false) { out["is_unilateral"] = .bool(isUnilateral) }
        let groups = DefinitionForm.splitList(muscleGroups)
        if groups != (d.muscleGroups ?? []) { out["muscle_groups"] = .array(groups.map(JSONValue.string)) }
        let gear = DefinitionForm.splitList(equipment)
        if gear != (d.equipment ?? []) { out["equipment"] = .array(gear.map(JSONValue.string)) }
        let notes = techniqueNotes.trimmingCharacters(in: .whitespacesAndNewlines)
        if notes != (d.techniqueNotes ?? "") { out["technique_notes"] = notes.isEmpty ? .null : .string(notes) }

        let sets = Int(defaultSets.trimmingCharacters(in: .whitespaces))
        if sets != d.defaultSets, !(sets == nil && d.defaultSets == nil) {
            out["default_sets"] = sets.map { .number(Double($0)) } ?? .null
        }
        for (column, typed, stored) in [
            ("default_reps", defaultReps, d.defaultReps),
            ("default_duration", defaultDuration, d.defaultDuration),
            ("default_weight", defaultWeight, d.defaultWeight),
            ("default_rest", defaultRest, d.defaultRest),
        ] {
            let value = typed.trimmingCharacters(in: .whitespaces)
            if value != (stored ?? "") { out[column] = value.isEmpty ? .null : .string(value) }
        }
        return out
    }

    /// `splitList` in DefinitionEditor.tsx.
    static func splitList(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}
