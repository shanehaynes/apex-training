import ApexCore
import SwiftUI

extension ChartPalette {
    /// The colour a rendered series takes (design-spec §1): a ramp slot, or a
    /// workout type's own `border` so "weights" is the same red everywhere.
    public static func color(for series: SeriesColor) -> Color {
        switch series {
        case .ramp(let index):
            seriesRamp[index % seriesRamp.count]
        case .workoutType(let type):
            WorkoutTypeTokens.palette(for: type).border
        }
    }
}
