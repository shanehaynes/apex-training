import ApexCore
import ApexUI
import SwiftUI

/// The rest countdown between sets (D-015): "Rest · 1:23", a thinning line
/// for the round, +15 s and Skip. Lives in the tracker's bottom inset with
/// the finish gate, so the keyboard lifts it to the thumb rather than hiding
/// it — the set was just typed, so the keyboard is up.
///
/// Reads `restRemaining` off the model (refreshed by the tracker's one-second
/// tick) rather than running a `Text(timerInterval:)` of its own: the island
/// counts down on the system clock, this counts on the injected one, and the
/// two agree under `SystemClock`, which is what ships.
struct RestTimerBar: View {
    let model: TrackerModel

    var body: some View {
        VStack(spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Text("Rest")
                        .apexEyebrow()
                    Text(model.restLabel)
                        .font(.apex(.mono, size: TypeScale.xl, weight: .medium, relativeTo: .title3))
                        .monospacedDigit()
                        .foregroundStyle(ApexColor.textPrimary)
                        .contentTransition(.numericText(countsDown: true))
                        .accessibilityIdentifier("tracker.rest.remaining")
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Rest, \(model.restRemaining) seconds left")
                Spacer(minLength: Spacing.sm)
                control("+15 s") { model.extendRest() }
                    .accessibilityLabel("Add fifteen seconds of rest")
                    .accessibilityIdentifier("tracker.rest.extend")
                control("Skip") { model.skipRest() }
                    .accessibilityLabel("Skip the rest")
                    .accessibilityIdentifier("tracker.rest.skip")
            }
            // What is left of the round, thinning to nothing at zero.
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(ApexColor.borderSubtle)
                    Capsule()
                        .fill(ApexColor.accent)
                        .frame(width: proxy.size.width * (1 - model.restProgress))
                }
            }
            .frame(height: 3)
            .accessibilityHidden(true)
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.md)
        .padding(.bottom, Spacing.sm)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgElevated)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .apexAnimation(model.restRemaining)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracker.rest")
    }

    /// A capsule the size of the header's "Use last", grown to the 44pt target.
    private func control(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .lineLimit(1)
                .fixedSize()
                .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 36)
                .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}
