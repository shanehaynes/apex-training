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

    public struct Bucket: Codable, Sendable, Equatable {
        public let key: String
        public let label: String
    }

    public struct Series: Codable, Sendable, Equatable {
        public let key: String
        public let label: String
        public let unitKind: String?
        public let unit: String?
        public let axis: String?
        /// `nil` is a gap, not a zero — the chart breaks the line there.
        public let points: [Double?]
    }

    public struct Excluded: Codable, Sendable, Equatable {
        public let otherUnit: Int
        public let unparseable: Int
    }
}
