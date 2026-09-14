import Foundation

/// The numbers a tile shows, formatted the way `TileRenderer.tsx` formats
/// them: `—` for missing, ≥1000 rounded whole with separators, otherwise one
/// decimal with a trailing `.0` trimmed. Formatting is Swift-owned (D-008)
/// and pinned by `TileFormatTests`.
public enum TileFormat {
    public static let missing = "—"

    private static let grouped: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        f.maximumFractionDigits = 0
        return f
    }()

    public static func value(_ v: Double?) -> String {
        guard let v, v.isFinite else { return missing }
        if abs(v) >= 1000 {
            return grouped.string(from: NSNumber(value: v.rounded())) ?? String(Int(v.rounded()))
        }
        let tenths = (v * 10).rounded() / 10
        if tenths == tenths.rounded() { return String(Int(tenths)) }
        return String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), tenths)
    }

    /// A value with its unit, or the grade text when the series carries one.
    public static func value(_ series: TileData.Series, at index: Int) -> String {
        if let grade = series.gradeLabel(at: index) { return grade }
        let point = series.points.indices.contains(index) ? series.points[index] : nil
        let text = value(point)
        guard point != nil, let unit = series.unit, !unit.isEmpty else { return text }
        return "\(text) \(unit)"
    }

    /// The excluded-entries footnote, or nil when nothing was excluded.
    public static func excluded(count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? "1 entry excluded" : "\(count) entries excluded"
    }

    /// The dashboard's tile count: `1 tile`, `4 tiles`.
    public static func tileCount(_ n: Int) -> String { n == 1 ? "1 tile" : "\(n) tiles" }
}
