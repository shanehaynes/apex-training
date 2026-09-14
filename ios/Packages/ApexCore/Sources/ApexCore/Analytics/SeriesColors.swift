import Foundation

/// Which colour a rendered series takes — resolved to a `Color` in ApexUI.
public enum SeriesColor: Sendable, Equatable {
    /// A slot on the chart ramp (`ChartPalette.seriesRamp`, 8 entries).
    case ramp(Int)
    /// A workout type's own `border` colour, so "weights" is the same red everywhere.
    case workoutType(String)
}

/// `seriesColors` from `src/lib/analytics/palette.ts` (design-spec §1): a
/// series keyed `<id>:<group>` whose group is a workout type keeps the app's
/// colour for that type and consumes no ramp slot; everything else walks the
/// ramp in render order, wrapping. Vectors in `palette.test.ts`, copied into
/// `SeriesColorsTests` — a D-023 port of a mapping, not a decision.
public enum SeriesColors {
    public static let rampSize = 8

    /// The workout types the web's palette knows, from the generated catalog.
    public static let knownTypes: Set<String> = Set(AnalyticsCatalog.workoutTypes.map(\.value))

    public static func assign(keys: [String], knownTypes: Set<String> = knownTypes) -> [SeriesColor] {
        var rampIndex = 0
        return keys.map { key in
            if let group = group(of: key), knownTypes.contains(group) {
                return .workoutType(group)
            }
            defer { rampIndex += 1 }
            return .ramp(rampIndex % rampSize)
        }
    }

    /// The group value a series was fanned out on, or nil.
    public static func group(of key: String) -> String? {
        guard let colon = key.firstIndex(of: ":") else { return nil }
        return String(key[key.index(after: colon)...])
    }
}
