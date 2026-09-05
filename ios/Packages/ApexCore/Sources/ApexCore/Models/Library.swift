import Foundation

/// `POST /api/query { tool: "search_exercises" }` — `api/_lib/mcp/tools/library.ts`.
/// Carries no definition id, so it decorates a picker (last performed) rather
/// than driving one; the cached `definitions` from `/api/schedule` do that.
public struct SearchExercisesResult: Codable, Sendable, Equatable {
    public let query: String?
    public let totalMatches: Int
    public let exercises: [Entry]

    public struct Entry: Codable, Sendable, Equatable {
        public let canonicalName: String
        public let category: String?
        public let aliases: [String]?
        public let isUnilateral: Bool?
        public let lastPerformed: String?
        public let archived: Bool?

        enum CodingKeys: String, CodingKey {
            case canonicalName = "canonical_name"
            case category, aliases
            case isUnilateral = "is_unilateral"
            case lastPerformed = "last_performed"
            case archived
        }
    }

    enum CodingKeys: String, CodingKey {
        case query
        case totalMatches = "total_matches"
        case exercises
    }
}
