import Foundation

/// Which exercise a spoken phrase names. Keys are `voiceKey`s — punctuation
/// gone, shorthand expanded, plurals dropped — on purpose unlike the picker's
/// `normalize` (D-059): speech carries no casing, hyphens or parentheses, and
/// "squats" means the squat. Tiers stop at the first that yields: exact in
/// the session, contained in the session, near in the session (the picker's
/// typo budget, `NearMatch.budget`), exact in the library, contained or near
/// in the library, unresolved.
public enum VoiceExercise {
    /// Gym shorthand, expanded per word before singularising.
    static let wordShorthand: [String: String] = [
        "db": "dumbbell", "bb": "barbell", "kb": "kettlebell", "ohp": "overhead press",
        "rdl": "romanian deadlift", "rdls": "romanian deadlifts", "dl": "deadlift", "sldl": "stiff leg deadlift",
        "chin": "chin up", "chins": "chin ups",
    ]

    /// At most this many library candidates are offered.
    static let libraryCandidateLimit = 3

    /// Lowercase words, split on anything that is not a letter or digit,
    /// shorthand expanded, each singularised (`ies` → `y`; a final `s` dropped
    /// when the word is longer than three letters and does not end in `ss`).
    public static func voiceWords(_ text: String) -> [String] {
        var raw: [String] = []
        var current = ""
        for ch in text.lowercased() {
            if ch.isLetter || ch.isNumber { current.append(ch) } else if !current.isEmpty { raw.append(current); current = "" }
        }
        if !current.isEmpty { raw.append(current) }
        var words: [String] = []
        var skip = false
        for (i, word) in raw.enumerated() {
            if skip { skip = false; continue }
            let next = i + 1 < raw.count ? raw[i + 1] : ""
            // "body weight" is one word of a name ("Bodyweight Squat"), however it was split.
            if word == "body", next == "weight" {
                words.append("bodyweight")
                skip = true
                continue
            }
            // "chin ups" is already spelled out; only a lone "chin(s)" expands.
            let expanded = (word == "chin" || word == "chins") && (next == "up" || next == "ups") ? word : wordShorthand[word] ?? word
            for part in expanded.split(separator: " ") { words.append(singularise(String(part))) }
        }
        return words
    }

    /// The words joined, singularised once more: "weighted pull ups" → "weighted pull up".
    public static func voiceKey(_ text: String) -> String {
        singularise(voiceWords(text).joined(separator: " "))
    }

    static func singularise(_ word: String) -> String {
        if word.hasSuffix("ies"), word.count > 3 { return String(word.dropLast(3)) + "y" }
        if word.hasSuffix("s"), !word.hasSuffix("ss"), word.count > 3 { return String(word.dropLast()) }
        return word
    }

    /// "Lat Pulldown (Close Grip)" → "Lat Pulldown": a second key per name.
    static func withoutParenthetical(_ name: String) -> String? {
        guard let open = name.firstIndex(of: "("), let close = name[open...].firstIndex(of: ")") else { return nil }
        let stripped = (name[..<open] + name[name.index(after: close)...]).trimmingCharacters(in: .whitespaces)
        return stripped.isEmpty ? nil : stripped
    }

    /// Word membership that forgives the plural the three-letter rule keeps:
    /// "up" is in "pull ups" (the fixture's case 60).
    static func sameWord(_ a: String, _ b: String) -> Bool {
        a == b || a + "s" == b || b + "s" == a
    }

    struct Candidate {
        let scope: SpokenExercise.Scope
        let id: String
        let name: String
        let keys: [String]
        let words: [String]

        init(scope: SpokenExercise.Scope, id: String, name: String, names: [String]) {
            self.scope = scope
            self.id = id
            self.name = name
            var keys: [String] = []
            var words: [String] = []
            for n in names {
                for variant in [n] + (withoutParenthetical(n).map { [$0] } ?? []) {
                    let key = voiceKey(variant)
                    if !key.isEmpty, !keys.contains(key) { keys.append(key) }
                }
                for w in voiceWords(n) where !words.contains(w) { words.append(w) }
            }
            self.keys = keys
            self.words = words
        }

        func isExact(_ key: String) -> Bool { keys.contains(key) }
        func contains(_ phraseWords: [String]) -> Bool {
            phraseWords.allSatisfy { p in words.contains { sameWord(p, $0) } }
        }
        func distance(to key: String) -> Int { keys.map { NearMatch.distance(key, $0) }.min() ?? Int.max }
        func spoken(_ match: SpokenExercise.Match, distance: Int = 0) -> SpokenExercise.Candidate {
            SpokenExercise.Candidate(scope: scope, id: id, name: name, match: match, distance: distance)
        }
    }

    static func sessionCandidates(_ context: VoiceContext) -> [Candidate] {
        context.session.map { exercise in
            var names = [exercise.name]
            if let definition = context.library.first(where: { $0.id == exercise.definitionId }) {
                names.append(definition.canonicalName)
                names.append(contentsOf: definition.aliases ?? [])
            }
            return Candidate(scope: .session, id: exercise.id, name: exercise.name, names: names)
        }
    }

    /// Set-tracked, unarchived definitions only: `applySpoken` refuses cardio
    /// and climbing, so offering one would add an exercise nothing can fill.
    static let unsupportedCategories: Set<String> = ["cardio", "climbing"]

    static func libraryCandidates(_ context: VoiceContext) -> [Candidate] {
        context.library.filter { $0.archivedAt == nil && !unsupportedCategories.contains($0.category ?? "") }.map {
            Candidate(scope: .library, id: $0.id, name: $0.canonicalName, names: [$0.canonicalName] + ($0.aliases ?? []))
        }
    }

    /// Everything one utterance resolves against, built once per utterance:
    /// the candidates per tier and every key a known name answers to, which
    /// `VoiceSlots.extractPhrase` uses to recognise a name whose words are
    /// also keywords ("bodyweight squat", "quarter squat", "log press").
    struct Catalog {
        let session: [Candidate]
        let library: [Candidate]
        let knownKeys: Set<String>

        init(context: VoiceContext) {
            session = sessionCandidates(context)
            library = libraryCandidates(context)
            knownKeys = Set((session + library).flatMap(\.keys))
        }
    }

    /// The tiers, for a phrase that has already been separated from the values.
    public static func resolveExercisePhrase(_ phrase: String, context: VoiceContext) -> SpokenExercise {
        resolve(phrase, in: Catalog(context: context))
    }

    static func resolve(_ phrase: String, in catalog: Catalog) -> SpokenExercise {
        let words = voiceWords(phrase)
        let key = voiceKey(phrase)
        guard !words.isEmpty else { return .current }
        let session = catalog.session

        let exactSession = session.filter { $0.isExact(key) }
        if exactSession.count == 1 { return .resolved(scope: .session, id: exactSession[0].id, name: exactSession[0].name, match: .exact) }
        if exactSession.count > 1 { return .needsConfirmation(phrase: phrase, candidates: exactSession.map { $0.spoken(.exact) }) }

        let containedSession = session.filter { $0.contains(words) }
        if containedSession.count == 1 {
            return .resolved(scope: .session, id: containedSession[0].id, name: containedSession[0].name, match: .contained)
        }
        if containedSession.count > 1 { return .needsConfirmation(phrase: phrase, candidates: containedSession.map { $0.spoken(.contained) }) }

        let budget = NearMatch.budget(key.count)
        let nearSession = session.map { ($0, $0.distance(to: key)) }.filter { $0.1 <= budget }
        if !nearSession.isEmpty {
            let ordered = nearSession.enumerated().sorted { ($0.element.1, $0.offset) < ($1.element.1, $1.offset) }
            return .needsConfirmation(phrase: phrase, candidates: ordered.map { $0.element.0.spoken(.near, distance: $0.element.1) })
        }

        let library = catalog.library
        let exactLibrary = library.filter { $0.isExact(key) }
        if exactLibrary.count == 1 { return .resolved(scope: .library, id: exactLibrary[0].id, name: exactLibrary[0].name, match: .exact) }
        if exactLibrary.count > 1 { return .needsConfirmation(phrase: phrase, candidates: exactLibrary.map { $0.spoken(.exact) }) }

        var candidates: [SpokenExercise.Candidate] = []
        for candidate in library where candidate.contains(words) {
            candidates.append(candidate.spoken(.contained))
        }
        let nearLibrary = library.map { ($0, $0.distance(to: key)) }.filter { $0.1 <= budget }
            .enumerated().sorted { ($0.element.1, $0.offset) < ($1.element.1, $1.offset) }
        for (candidate, distance) in nearLibrary.map(\.element) where !candidates.contains(where: { $0.id == candidate.id }) {
            candidates.append(candidate.spoken(.near, distance: distance))
        }
        if !candidates.isEmpty { return .needsConfirmation(phrase: phrase, candidates: Array(candidates.prefix(libraryCandidateLimit))) }

        return .unresolved(phrase: phrase)
    }
}
