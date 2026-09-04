import Foundation

/// The `${baseId}__${date}` synthetic-id convention (`src/lib/schedule/occurrence.ts`,
/// ported verbatim — its test vectors run in `OccurrenceIDTests`). Expanded
/// occurrences of a recurring event carry the base id plus the date; the series
/// anchor's own occurrence carries the bare base id. This is the only place
/// that knows the separator.
public enum OccurrenceID {
    public static let separator = "__"

    public static func make(baseId: String, date: String) -> String {
        baseId + separator + date
    }

    public static func isOccurrence(_ id: String) -> Bool {
        id.contains(separator)
    }

    /// The base event id — `id` unchanged when it is not an occurrence id.
    public static func baseId(of id: String) -> String {
        guard let range = id.range(of: separator) else { return id }
        return String(id[..<range.lowerBound])
    }

    /// The occurrence date, or nil when `id` is not an occurrence id.
    public static func date(of id: String) -> String? {
        guard let range = id.range(of: separator) else { return nil }
        return String(id[range.upperBound...])
    }

    /// True for the base id itself and for every occurrence expanded from it.
    public static func belongs(_ id: String, to baseId: String) -> Bool {
        id == baseId || id.hasPrefix(baseId + separator)
    }
}
