import ApexCore
import ApexUI
import SwiftUI

/// The Live Activity's views, one per placement (design-spec: house colours on
/// the Lock Screen, the island's own black behind the compact and expanded
/// forms). `ApexWidgets` composes these into its `ActivityConfiguration`; the
/// snapshot tests render them directly.
///
/// Title truncation rule (the brief's acceptance asks for it in writing):
/// - compact and minimal: no title at all — the timer, or the glyph.
/// - expanded centre: one line, tail-truncated.
/// - Lock Screen banner: two lines, tail-truncated — the same rule as the
///   tracker header (U27), which never cuts a title mid-word on a phone.
public enum TrackerActivityViews {
    public typealias State = TrackerActivityAttributes.ContentState

    static let glyph = ApexIcon.dumbbell.systemName

    // MARK: - Timer

    /// Running: the system renders the elapsed time from `startedAt`, so the
    /// activity never needs an update while the workout is going. Done: the
    /// total, formatted the way the tracker header shows it.
    public struct Timer: View {
        let state: State
        var font: Font
        var color: Color

        public init(state: State, font: Font, color: Color = ApexColor.textPrimary) {
            self.state = state
            self.font = font
            self.color = color
        }

        public var body: some View {
            Group {
                switch state.phase {
                case .running:
                    Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                case .done(let total):
                    Text(DurationBuffer.formatElapsed(total))
                }
            }
            .font(font)
            .monospacedDigit()
            .foregroundStyle(color)
            .lineLimit(1)
        }
    }

    static func exerciseLabel(_ count: Int?) -> String? {
        guard let count, count > 0 else { return nil }
        return "\(count) exercise\(count == 1 ? "" : "s")"
    }

    // MARK: - Lock Screen banner

    public struct LockScreen: View {
        let attributes: TrackerActivityAttributes
        let state: State

        public init(attributes: TrackerActivityAttributes, state: State) {
            self.attributes = attributes
            self.state = state
        }

        public var body: some View {
            HStack(alignment: .center, spacing: Spacing.md) {
                Image(systemName: glyph)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(state.isDone ? ApexPalette.positive : ApexColor.accent)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    // The eyebrow pattern (design-spec §2) by hand: `apexEyebrow()`
                    // fixes the colour and the "Done" state needs the positive one.
                    Text(state.isDone ? "Done" : "Workout")
                        .font(.apex(.display, size: TypeScale.micro, weight: .bold, relativeTo: .caption))
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(state.isDone ? ApexPalette.positive : ApexColor.textMuted)
                    Text(attributes.title)
                        .font(.apex(.display, size: TypeScale.base, weight: .semibold))
                        .foregroundStyle(ApexColor.textPrimary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                    if let label = exerciseLabel(state.exerciseCount) {
                        Text(label)
                            .font(.apex(.display, size: TypeScale.sm))
                            .foregroundStyle(ApexColor.textSecondary)
                    }
                }
                Spacer(minLength: Spacing.sm)
                Timer(state: state, font: .apex(.mono, size: TypeScale.xl, weight: .medium))
            }
            .padding(Spacing.lg)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Dynamic Island, expanded

    public struct ExpandedLeading: View {
        let state: State

        public init(state: State) { self.state = state }

        public var body: some View {
            Image(systemName: glyph)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(state.isDone ? ApexPalette.positive : ApexColor.accent)
                .padding(.leading, Spacing.xs)
        }
    }

    public struct ExpandedTrailing: View {
        let state: State

        public init(state: State) { self.state = state }

        public var body: some View {
            Timer(state: state, font: .apex(.mono, size: TypeScale.lg, weight: .medium))
                .padding(.trailing, Spacing.xs)
        }
    }

    public struct ExpandedCenter: View {
        let attributes: TrackerActivityAttributes
        let state: State

        public init(attributes: TrackerActivityAttributes, state: State) {
            self.attributes = attributes
            self.state = state
        }

        public var body: some View {
            Text(attributes.title)
                .font(.apex(.display, size: TypeScale.sm, weight: .semibold))
                .foregroundStyle(ApexColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    public struct ExpandedBottom: View {
        let state: State

        public init(state: State) { self.state = state }

        public var body: some View {
            HStack(spacing: Spacing.sm) {
                Text(state.isDone ? "Done" : (exerciseLabel(state.exerciseCount) ?? "In progress"))
                    .font(.apex(.display, size: TypeScale.xs))
                    .foregroundStyle(ApexColor.textSecondary)
                Spacer()
                HStack(spacing: Spacing.xs) {
                    Text("Open")
                    Image(systemName: ApexIcon.chevronRight.systemName)
                }
                .font(.apex(.display, size: TypeScale.xs, weight: .medium))
                .foregroundStyle(ApexColor.accent)
            }
            .padding(.horizontal, Spacing.xs)
            .padding(.top, Spacing.xs)
        }
    }

    // MARK: - Dynamic Island, compact and minimal

    /// System font here on purpose: the compact island is 22pt tall and Apple
    /// tunes San Francisco for it; a custom face reads worse and clips.
    public struct CompactLeading: View {
        let state: State

        public init(state: State) { self.state = state }

        public var body: some View {
            Image(systemName: glyph)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(state.isDone ? ApexPalette.positive : ApexColor.accent)
        }
    }

    public struct CompactTrailing: View {
        let state: State

        public init(state: State) { self.state = state }

        public var body: some View {
            Timer(state: state, font: .system(size: 14, weight: .semibold), color: ApexColor.accent)
                // A fixed frame so the digits never push the island wider as
                // the minutes roll over; wide enough for h:mm:ss.
                .frame(minWidth: 44, alignment: .trailing)
        }
    }

    public struct Minimal: View {
        let state: State

        public init(state: State) { self.state = state }

        public var body: some View {
            Image(systemName: glyph)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(state.isDone ? ApexPalette.positive : ApexColor.accent)
        }
    }
}

/// The expanded island, laid out the way the system does — leading · centre ·
/// trailing over a bottom row — so a snapshot can prove the truncation rule
/// without a device. Not used by the extension itself.
public enum TrackerActivityPreviews {
    public static func expanded(attributes: TrackerActivityAttributes, state: TrackerActivityAttributes.ContentState) -> some View {
        VStack(spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                TrackerActivityViews.ExpandedLeading(state: state)
                TrackerActivityViews.ExpandedCenter(attributes: attributes, state: state)
                    .frame(maxWidth: .infinity)
                TrackerActivityViews.ExpandedTrailing(state: state)
            }
            TrackerActivityViews.ExpandedBottom(state: state)
        }
        .padding(Spacing.md)
        .background(Color.black, in: RoundedRectangle(cornerRadius: 44, style: .continuous))
    }

    public static func lockScreen(attributes: TrackerActivityAttributes, state: TrackerActivityAttributes.ContentState) -> some View {
        TrackerActivityViews.LockScreen(attributes: attributes, state: state)
            .background(ApexColor.bgSurface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}
