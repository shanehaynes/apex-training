import Foundation

/// `src/lib/schedule/supersets.ts`, ported with its vectors (D-027). A superset
/// is CONSECUTIVE entries in one section sharing `Exercise.superset`. These
/// are the only writers of that field on the phone: they keep labels
/// canonical (A, B, … in order of appearance), enforce adjacency after a
/// drag, and clear singleton labels — a superset of one is meaningless. The
/// server runs the same normalisation on every write, so a label the editor
/// shows is the label the table keeps.
public enum Supersets {
    private static let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")

    /// Re-letter a section's groups: consecutive runs of a shared label become
    /// A, B, … in order; a run of one loses its label; a label split apart by
    /// a reorder becomes two runs (each re-lettered, singletons cleared).
    public static func normalize(_ entries: [Exercise]) -> [Exercise] {
        var runs: [[Exercise]] = []
        for entry in entries {
            if let label = entry.superset, !label.isEmpty, let last = runs.last, last[0].superset == label {
                runs[runs.count - 1].append(entry)
            } else {
                runs.append([entry])
            }
        }
        var next = 0
        var out: [Exercise] = []
        for run in runs {
            let grouped = run.count > 1 && !(run[0].superset ?? "").isEmpty
            let label: String? = grouped ? String(letters[next % letters.count]) : nil
            if grouped { next += 1 }
            for entry in run {
                var copy = entry
                copy.superset = label
                out.append(copy)
            }
        }
        return out
    }

    /// Group this entry with the one above it (joining its group, or forming
    /// a new pair). No-op on the first entry of a section.
    public static func linkWithAbove(_ entries: [Exercise], id: String) -> [Exercise] {
        guard let index = entries.firstIndex(where: { $0.id == id }), index > 0 else { return entries }
        let label = entries[index - 1].superset.flatMap { $0.isEmpty ? nil : $0 } ?? "*"
        var next = entries
        next[index].superset = label
        next[index - 1].superset = label
        return normalize(next)
    }

    /// Pull this entry out of its group (the rest re-letter, singletons clear).
    public static func unlink(_ entries: [Exercise], id: String) -> [Exercise] {
        var next = entries
        if let index = next.firstIndex(where: { $0.id == id }) { next[index].superset = nil }
        return normalize(next)
    }
}
