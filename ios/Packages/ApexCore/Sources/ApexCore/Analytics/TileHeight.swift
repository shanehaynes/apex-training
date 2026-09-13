import Foundation

/// The three tile heights the phone offers (D-011): stored as the grid's `h`
/// rows so the web reads the same number back. A foreign height (a web drag)
/// snaps to the nearest step for the edit chips without being rewritten
/// until the user commits.
public enum TileHeight: Int, CaseIterable, Sendable, Hashable, Identifiable {
    case small = 2
    case medium = 4
    case large = 6

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .small: "S"
        case .medium: "M"
        case .large: "L"
        }
    }

    /// The card body height on the phone, in points.
    public var points: Double {
        switch self {
        case .small: 140
        case .medium: 260
        case .large: 380
        }
    }

    /// The nearest step to a stored `h`; ties round up (3 → M, 5 → L).
    public static func nearest(h: Int) -> TileHeight {
        allCases.min { a, b in
            let da = abs(a.rawValue - h), db = abs(b.rawValue - h)
            return da != db ? da < db : a.rawValue > b.rawValue
        }!
    }
}
