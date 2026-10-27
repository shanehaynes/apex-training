import Foundation
import XCTest
@testable import ApexCore

/// `Fixtures/voice-cases.json`, the voice grammar's contract (W17), read the
/// way a web port would read it: the expectation shapes are spelled here, not
/// the Swift types' own encodings, so the JSON stays hand-writable.
struct VoiceFixture: Decodable {
    let version: Int
    let contexts: [String: Context]
    let cases: [Case]

    struct Context: Decodable {
        /// Copy `session` and `library` from this context; `unit` and
        /// `currentExerciseId` are always spelled out.
        let base: String?
        let unit: String?
        let currentExerciseId: String?
        let session: [SessionExercise]?
        let library: [ExerciseDefinition]?
    }

    struct SessionExercise: Decodable {
        let id: String
        let section: String
        let name: String
        let definitionId: String?
        /// By log-field name: weight, reps, duration.
        let fields: [String]
    }

    struct Case: Decodable {
        let id: String
        let name: String
        let source: String
        let rules: [String]
        let context: String
        let input: [String]
        let expect: Expectation
        let storage: [String: String]

        var label: String { "case \(id) (\(name))" }
    }

    struct Expectation: Decodable {
        let status: String
        let chosen: Int
        let intent: Intent?
        let exercise: Exercise
        let ignored: [String]
        let problems: [String]
    }

    struct Intent: Decodable {
        let kind: String
        let sets: Int?
        let values: SpokenValues?
    }

    struct Exercise: Decodable {
        let kind: String
        let scope: String?
        let id: String?
        let name: String?
        let match: String?
        let phrase: String?
        let candidates: [SpokenExercise.Candidate]?
    }

    static func load() throws -> VoiceFixture {
        try JSONDecoder().decode(VoiceFixture.self, from: try TestFixtures.local("voice-cases.json"))
    }

    func context(named name: String) throws -> VoiceContext {
        let raw = try XCTUnwrap(contexts[name], "fixture context \(name)")
        let base = raw.base.flatMap { contexts[$0] }
        let session = try XCTUnwrap(raw.session ?? base?.session, "context \(name) has no session")
        let library = try XCTUnwrap(raw.library ?? base?.library, "context \(name) has no library")
        return VoiceContext(
            unit: raw.unit.flatMap(Weight.Unit.init(rawValue:)),
            session: try session.map {
                VoiceSessionExercise(
                    id: $0.id, section: $0.section, name: $0.name, definitionId: $0.definitionId,
                    fields: try $0.fields.map { try XCTUnwrap(SetField(logField: $0), "unknown field \($0)") }
                )
            },
            currentExerciseId: raw.currentExerciseId,
            library: library
        )
    }
}

extension VoiceFixture.Intent {
    var spoken: SpokenIntent? {
        switch kind {
        case "repeat": return .repeat
        case "log": return .log(sets: sets ?? 1, values: values ?? SpokenValues())
        default: return nil
        }
    }
}

extension VoiceFixture.Exercise {
    var spoken: SpokenExercise? {
        switch kind {
        case "current":
            return .current
        case "resolved":
            guard let scope = scope.flatMap(SpokenExercise.Scope.init(rawValue:)), let id, let name,
                  let match = match.flatMap(SpokenExercise.Match.init(rawValue:)) else { return nil }
            return .resolved(scope: scope, id: id, name: name, match: match)
        case "needsConfirmation":
            guard let phrase, let candidates else { return nil }
            return .needsConfirmation(phrase: phrase, candidates: candidates)
        case "unresolved":
            guard let phrase else { return nil }
            return .unresolved(phrase: phrase)
        default:
            return nil
        }
    }

    /// Which resolution tier the expectation exercises — the coverage test
    /// wants every tier in at least one case.
    var tier: String {
        switch (kind, scope, match, candidates?.first?.scope.rawValue, candidates?.first?.match.rawValue) {
        case ("current", _, _, _, _): return "current"
        case ("resolved", "session", "exact", _, _): return "1 exact-session"
        case ("resolved", "session", "contained", _, _), ("needsConfirmation", _, _, "session", "contained"): return "2 contained-session"
        case ("needsConfirmation", _, _, "session", "near"): return "3 near-session"
        case ("resolved", "library", _, _, _), ("needsConfirmation", _, _, "library", "exact"): return "4 exact-library"
        case ("needsConfirmation", _, _, "library", _): return "5 contained-or-near-library"
        case ("unresolved", _, _, _, _): return "6 unresolved"
        default: return "unknown (\(kind))"
        }
    }
}
