import Foundation

/// The one piece of `src/lib/nutrition` that runs on the phone (D-032): the
/// composer's live "derived kcal" placeholder cannot round-trip to the server
/// on every keystroke. Four constants, pinned against vectors the web repo
/// emits from its own `derivedCalories` (`ios/Fixtures/nutrition-derived.json`).
/// Nothing else — sums, display rounding, the fat-split rule — is ported:
/// the server owns those and refuses with the composer's own words.
public enum Nutrition {
    /// Atwater 4/4/9/7; nil when no macro is set at all.
    public static func derivedCalories(
        proteinG: Double?, carbsG: Double?, fatTotalG: Double?, alcoholG: Double?
    ) -> Int? {
        if proteinG == nil, carbsG == nil, fatTotalG == nil, alcoholG == nil { return nil }
        let total = (proteinG ?? 0) * 4 + (carbsG ?? 0) * 4 + (fatTotalG ?? 0) * 9 + (alcoholG ?? 0) * 7
        // `Math.round` rounds halves up; for the non-negative totals a meal
        // can have, away-from-zero is the same rule.
        return Int(total.rounded(.toNearestOrAwayFromZero))
    }
}
