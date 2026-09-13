import Foundation

/// `POST /api/analytics-compute` (W8). The server owns the whole computation;
/// Swift Charts draws what comes back and validates nothing.
public struct AnalyticsComputeResponse: Codable, Sendable, Equatable {
    public let today: String
    public let tiles: [TileResult]
}

/// A tile either computed or explained why it could not.
public enum TileResult: Codable, Sendable, Equatable {
    case ok(TileData)
    case problem(String)

    private enum CodingKeys: String, CodingKey { case ok, data, problem }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(Bool.self, forKey: .ok) {
            self = .ok(try container.decode(TileData.self, forKey: .data))
        } else {
            self = .problem(try container.decodeIfPresent(String.self, forKey: .problem) ?? "Could not compute")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ok(let data):
            try container.encode(true, forKey: .ok)
            try container.encode(data, forKey: .data)
        case .problem(let problem):
            try container.encode(false, forKey: .ok)
            try container.encode(problem, forKey: .problem)
        }
    }
}

public struct TileData: Codable, Sendable, Equatable {
    public let buckets: [Bucket]
    public let series: [Series]
    public let excluded: Excluded?
    public let rangeLabel: String?

    public init(buckets: [Bucket], series: [Series], excluded: Excluded? = nil, rangeLabel: String? = nil) {
        self.buckets = buckets
        self.series = series
        self.excluded = excluded
        self.rangeLabel = rangeLabel
    }

    public struct Bucket: Codable, Sendable, Equatable {
        public let key: String
        public let label: String

        public init(key: String, label: String) {
            self.key = key
            self.label = label
        }
    }

    public struct Series: Codable, Sendable, Equatable {
        /// `<seriesId>` or `<seriesId>:<group>` when fanned out by a split.
        public let key: String
        public let label: String
        public let unitKind: String?
        public let unit: String?
        public let axis: String?
        /// `nil` is a gap, not a zero — the chart breaks the line there.
        public let points: [Double?]
        /// `max-grade` only: the grade text behind each bucket's rank. Where
        /// present it replaces the number everywhere (W9) — a rank is never
        /// formatted.
        public let gradeLabels: [String?]?

        public init(key: String, label: String, unitKind: String? = nil, unit: String? = nil, axis: String? = nil, points: [Double?], gradeLabels: [String?]? = nil) {
            self.key = key
            self.label = label
            self.unitKind = unitKind
            self.unit = unit
            self.axis = axis
            self.points = points
            self.gradeLabels = gradeLabels
        }

        /// The grade text for a bucket when this is a grade series, else nil.
        public func gradeLabel(at index: Int) -> String? {
            guard let labels = gradeLabels, labels.indices.contains(index) else { return nil }
            return labels[index]
        }
    }

    public struct Excluded: Codable, Sendable, Equatable {
        public let otherUnit: Int
        public let unparseable: Int

        public init(otherUnit: Int, unparseable: Int) {
            self.otherUnit = otherUnit
            self.unparseable = unparseable
        }

        public var total: Int { otherUnit + unparseable }
    }

    /// Entries whose units could not join the chart — the footnote's count.
    public var excludedCount: Int { excluded?.total ?? 0 }
}

// MARK: - Tiles (W9)

/// The grid placement the web stores per tile (`x`,`y`,`w`,`h` on
/// `analytics_tiles`). On the phone `x` is 0 and `w` is 12 (D-011).
public struct TileLayout: Codable, Sendable, Equatable {
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int

    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

/// One saved dashboard tile as `GET /api/analytics-tiles` serves it: the
/// stored spec (which the dashboard sends back to compute), the draft the
/// builder edits (`draftFromSpec`, run server-side), and the layout. Both
/// `spec` and `draft` are nil when the stored row no longer validates — the
/// title survives so the error tile stays nameable.
public struct AnalyticsTile: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public var title: String
    public var spec: JSONValue?
    public var draft: ChartDraft?
    public var layout: TileLayout
    public var updatedAt: String?

    public init(id: String, title: String, spec: JSONValue?, draft: ChartDraft?, layout: TileLayout, updatedAt: String? = nil) {
        self.id = id
        self.title = title
        self.spec = spec
        self.draft = draft
        self.layout = layout
        self.updatedAt = updatedAt
    }

    /// The chart type the tile draws as, from the draft (nil = the invalid tile).
    public var chartType: String? { draft?.chartType }
}

/// What the builder's pickers offer beyond the catalog: the caller's own
/// exercise categories and the titles of workouts whose sport is "other".
public struct TileOptions: Codable, Sendable, Equatable {
    public var categories: [String]
    public var otherWorkoutTitles: [String]

    public init(categories: [String] = [], otherWorkoutTitles: [String] = []) {
        self.categories = categories
        self.otherWorkoutTitles = otherWorkoutTitles
    }

    public static let empty = TileOptions()
}

/// `GET /api/analytics-tiles`.
public struct AnalyticsTilesResponse: Codable, Sendable, Equatable {
    public let tiles: [AnalyticsTile]
    public let options: TileOptions

    public init(tiles: [AnalyticsTile], options: TileOptions) {
        self.tiles = tiles
        self.options = options
    }
}

/// `POST /api/analytics-tiles { id, draft, layout }`: `ok:false` carries the
/// web's own pre-save text (`Give the tile a title`, `chartDraftProblem`) on a
/// 200, the coach-tool convention; `ok:true` carries the tile as GET would.
public struct TileSaveResponse: Codable, Sendable, Equatable {
    public let ok: Bool
    public let problem: String?
    public let tile: AnalyticsTile?

    public init(ok: Bool, problem: String? = nil, tile: AnalyticsTile? = nil) {
        self.ok = ok
        self.problem = problem
        self.tile = tile
    }
}

/// Tile ids are client-minted, like the web's `mintTileId`.
public enum TileID {
    public static func mint() -> String { "tile-" + UUID().uuidString.lowercased() }
}
