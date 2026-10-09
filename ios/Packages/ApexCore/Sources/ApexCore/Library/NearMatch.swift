import Foundation

/// `nearMatchDefinitions` / `editDistance` in `src/lib/schedule/definitions.ts`:
/// the picker's "did you mean" before it offers to create. Substring search
/// misses a typo ("Pnacake Fold"), and a typo that reaches Create forks the
/// movement's history. Same key, budget and distance as the web, case for case
/// (`NearMatchTests` mirrors the web's table).
public enum NearMatch {
    /// Lowercase, letters/digits/spaces only, whitespace collapsed — "Pull-Up" ≈ "pullup".
    static func key(_ name: String) -> [Character] {
        let kept = name.lowercased().filter { $0.isLetter || $0.isNumber || $0.isWhitespace }
        return Array(kept.split(whereSeparator: \.isWhitespace).joined(separator: " "))
    }

    /// Edits a query of this length may be off by and still be "the same name".
    static func budget(_ length: Int) -> Int {
        if length < 4 { return 0 }
        if length <= 5 { return 1 }
        if length <= 10 { return 2 }
        return 3
    }

    /// Optimal string alignment distance: insert, delete, substitute, and swap
    /// two adjacent characters, each one edit — "pnacake" is one from "pancake".
    public static func distance(_ a: String, _ b: String) -> Int {
        distance(Array(a), Array(b))
    }

    static func distance(_ a: [Character], _ b: [Character]) -> Int {
        guard !a.isEmpty else { return b.count }
        guard !b.isEmpty else { return a.count }
        var rows = [[Int]](repeating: [Int](repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in 0...a.count { rows[i][0] = i }
        for j in 0...b.count { rows[0][j] = j }
        for i in 1...a.count {
            for j in 1...b.count {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1
                var d = min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
                if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1] { d = min(d, rows[i - 2][j - 2] + 1) }
                rows[i][j] = d
            }
        }
        return rows[a.count][b.count]
    }

    /// Library names `query` is probably a typo of, compared on the whole name
    /// and on its opening (query length ±1) so a half-typed "pnacake" still
    /// finds "Pancake Fold". Closest first, then by name; at most `limit`.
    public static func definitions(for query: String, in definitions: [ExerciseDefinition], limit: Int = 3) -> [ExerciseDefinition] {
        let q = key(query)
        let allowed = budget(q.count)
        guard allowed > 0 else { return [] }
        let scored = definitions.compactMap { definition -> (definition: ExerciseDefinition, distance: Int)? in
            var best = Int.max
            for name in [definition.canonicalName] + (definition.aliases ?? []) {
                let candidate = key(name)
                best = min(best, distance(q, candidate))
                for n in (q.count - 1)...(q.count + 1) where n > 0 && n < candidate.count {
                    best = min(best, distance(q, Array(candidate.prefix(n))))
                }
            }
            guard best <= allowed else { return nil }
            return (definition: definition, distance: best)
        }
        return scored
            .sorted {
                $0.distance != $1.distance
                    ? $0.distance < $1.distance
                    : $0.definition.canonicalName.localizedCaseInsensitiveCompare($1.definition.canonicalName) == .orderedAscending
            }
            .prefix(limit)
            .map { $0.definition }
    }
}
