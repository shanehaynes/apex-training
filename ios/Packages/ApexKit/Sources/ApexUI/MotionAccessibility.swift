import SwiftUI
import UIKit

/// Reduce Motion (design-spec §3, W13): the house spring, gated on the system
/// setting so a call site needs no `@Environment` of its own. Views that
/// already read `accessibilityReduceMotion` (the month slide, the chat cursor)
/// keep doing so; everything else goes through these two.
///
/// The gate is read two different ways, on purpose:
///
/// - `.apexAnimation(_:)` is **declarative**. SwiftUI stores the `Animation`
///   in the view tree, so the gate has to be a dependency of the view or
///   turning Reduce Motion on invalidates nothing and the view keeps animating
///   until something unrelated happens to redraw it.
///   `@Environment(\.accessibilityReduceMotion)` is that dependency; the
///   `UIAccessibility` static it replaces was not one.
/// - `Motion.animate` is **imperative** — it runs inside a gesture or a button
///   action and reads the setting at that moment, which is always the current
///   one. There is no stored value to invalidate and nothing to observe.
public extension View {
    /// `.animation(Motion.spring, value:)`, or the change applied at once when
    /// the user asked for less motion.
    func apexAnimation<V: Equatable>(_ value: V) -> some View {
        modifier(MotionAnimation(value: value))
    }
}

private struct MotionAnimation<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let value: V

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : Motion.spring, value: value)
    }
}

extension Motion {
    /// `withAnimation(Motion.spring)`, or the change applied at once when the
    /// user asked for less motion. See the note above on why this one reads
    /// `UIAccessibility` rather than the environment.
    @MainActor
    public static func animate<Result>(_ body: () throws -> Result) rethrows -> Result {
        if UIAccessibility.isReduceMotionEnabled {
            return try body()
        }
        return try withAnimation(spring, body)
    }
}
