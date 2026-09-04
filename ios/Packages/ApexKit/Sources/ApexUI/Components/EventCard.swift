import SwiftUI

/// The Day view's `.day-event-card`: a 3pt rail in the type's colour, a mono
/// time column, title and subtitle, and a 44pt completion control that is
/// always visible — the web hides its check until `:hover`, which touch never
/// reaches (U7).
public struct EventCard: View {
    private let rawType: String
    private let title: String
    private let subtitle: String?
    private let timeLabel: String?
    private let durationLabel: String?
    private let isCompleted: Bool
    private let onOpen: () -> Void
    private let onToggle: () -> Void

    public init(
        rawType: String,
        title: String,
        subtitle: String? = nil,
        timeLabel: String?,
        durationLabel: String?,
        isCompleted: Bool,
        onOpen: @escaping () -> Void,
        onToggle: @escaping () -> Void
    ) {
        self.rawType = rawType
        self.title = title
        self.subtitle = subtitle
        self.timeLabel = timeLabel
        self.durationLabel = durationLabel
        self.isCompleted = isCompleted
        self.onOpen = onOpen
        self.onToggle = onToggle
    }

    private var palette: WorkoutPalette { WorkoutTypeTokens.palette(for: rawType) }

    public var body: some View {
        HStack(spacing: 0) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: Spacing.md) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(palette.border)
                        .frame(width: 3)
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        HStack(spacing: Spacing.sm) {
                            if let timeLabel {
                                Text(timeLabel)
                                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                    .foregroundStyle(ApexColor.textSecondary)
                            }
                            if let durationLabel {
                                Text(durationLabel)
                                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                                    .foregroundStyle(ApexColor.textMuted)
                            }
                        }
                        Text(title)
                            .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .body))
                            .foregroundStyle(isCompleted ? ApexColor.textSecondary : ApexColor.textPrimary)
                            .strikethrough(isCompleted, color: ApexColor.textMuted)
                            .multilineTextAlignment(.leading)
                        if let subtitle, !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                        WorkoutTypeBadge(rawType: rawType)
                            .padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, Spacing.md)
                .padding(.leading, Spacing.md)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("event.card.\(title)")

            Button(action: onToggle) {
                (isCompleted ? ApexIcon.checkCircle : ApexIcon.circle).image
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(isCompleted ? ApexPalette.positive : ApexColor.textMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.trailing, Spacing.xs)
            .accessibilityLabel(isCompleted ? "Mark incomplete" : "Mark complete")
            .accessibilityIdentifier("event.toggle.\(title)")
        }
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.lg)
                .strokeBorder(ApexColor.borderSubtle, lineWidth: 1)
        )
        .opacity(isCompleted ? 0.82 : 1)
    }
}
