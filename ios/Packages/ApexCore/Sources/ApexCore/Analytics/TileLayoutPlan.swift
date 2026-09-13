import Foundation

/// One entry of `PATCH /api/analytics-tiles { layouts }` — every column, the
/// server requires all four.
public struct TileLayoutUpdate: Codable, Sendable, Equatable {
    public let id: String
    public let x: Int
    public let y: Int
    public let w: Int
    public let h: Int

    public init(id: String, x: Int, y: Int, w: Int, h: Int) {
        self.id = id
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public init(id: String, layout: TileLayout) {
        self.init(id: id, x: layout.x, y: layout.y, w: layout.w, h: layout.h)
    }

    public var layout: TileLayout { TileLayout(x: x, y: y, w: w, h: h) }
}

/// D-011 made concrete: the phone's list order and S/M/L chips map onto the
/// web's grid as full-width rows — `x = 0`, `w = 12`, `h ∈ {2,4,6}`, and
/// `y` cumulative so the web stacks them in the same order. Committing from
/// the phone therefore rewrites the web grid into rows; that is the decision,
/// not a bug.
public enum TileLayoutPlan {
    public static let phoneWidth = 12

    /// The layouts a commit writes: `order` is the list as the user left it,
    /// `heights` the chips (a tile absent from `heights` keeps its nearest step).
    public static func layouts(order: [AnalyticsTile], heights: [String: TileHeight]) -> [TileLayoutUpdate] {
        var y = 0
        return order.map { tile in
            let h = (heights[tile.id] ?? TileHeight.nearest(h: tile.layout.h)).rawValue
            defer { y += h }
            return TileLayoutUpdate(id: tile.id, x: 0, y: y, w: phoneWidth, h: h)
        }
    }

    /// Only the rows whose stored layout differs — the PATCH is per row.
    public static func changed(_ updates: [TileLayoutUpdate], from tiles: [AnalyticsTile]) -> [TileLayoutUpdate] {
        let stored = Dictionary(uniqueKeysWithValues: tiles.map { ($0.id, $0.layout) })
        return updates.filter { stored[$0.id] != $0.layout }
    }

    /// The bottom edge of the dashboard — where a new or duplicated tile goes
    /// (the web's `maxBottom`).
    public static func maxBottom(_ tiles: [AnalyticsTile]) -> Int {
        tiles.map { $0.layout.y + $0.layout.h }.max() ?? 0
    }

    /// A new tile's placement: full width at the bottom.
    public static func nextLayout(after tiles: [AnalyticsTile], height: TileHeight) -> TileLayout {
        TileLayout(x: 0, y: maxBottom(tiles), w: phoneWidth, h: height.rawValue)
    }

    /// The dashboard's display order: the web's `y` then `x` (the server
    /// already sorts, the cache may predate a commit).
    public static func ordered(_ tiles: [AnalyticsTile]) -> [AnalyticsTile] {
        tiles.sorted { a, b in
            a.layout.y != b.layout.y ? a.layout.y < b.layout.y : a.layout.x < b.layout.x
        }
    }
}
