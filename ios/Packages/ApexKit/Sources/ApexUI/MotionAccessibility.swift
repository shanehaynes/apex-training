import SwiftUI
import UIKit

/// Reduce Motion (design-spec §3, W13): the house spring, gated on the
/// system setting so a `withAnimation(Motion.spring)` site needs no
/// `@Environment` of its own. Views that already read
/// `accessibilityReduceMotion` (the month slide, the chat cursor) keep doing
/// so; everything else goes through these two.
extension Motion {
    /// `Motion.spring`, or nil when the user asked for less motion — for
    /// `.animation(_:value:)`.
    @MainActor
    public static var current: Animation? {
        UIAccessibility.isReduceMotionEnabled ? nil : spring
    }

    /// `withAnimation(Motion.spring)`, or the change applied at once when the
    /// user asked for less motion.
    @MainActor
    public static func animate<Result>(_ body: () throws -> Result) rethrows -> Result {
        if UIAccessibility.isReduceMotionEnabled {
            return try body()
        }
        return try withAnimation(spring, body)
    }
}
