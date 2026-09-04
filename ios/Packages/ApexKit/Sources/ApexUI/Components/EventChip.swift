import SwiftUI

/// The Month grid's `.event-chip`: translucent fill, a 3pt left border in the
/// type's solid colour, time and title on one line. Open-only — a 22pt chip
/// cannot host a 44pt control, so completion lives on the day sheet (D-023 note).
public struct EventChip: View {
    private let rawType: String
    private let title: String
    private let timeLabel: String?
    private let isCompleted: Bool

    /// `timeLabel` is kept in the signature for the accessibility label.
    public init(rawType: String, title: String, timeLabel: String?, isCompleted: Bool) {
        self.rawType = rawType
        self.title = title
        self.timeLabel = timeLabel
        self.isCompleted = isCompleted
    }

    private var palette: WorkoutPalette { WorkoutTypeTokens.palette(for: rawType) }

    public var body: some View {
        HStack(spacing: 3) {
            if isCompleted {
                Image(systemName: "checkmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(ApexPalette.positive)
            }
            Text(label)
                .font(.apex(.display, size: 10, weight: .medium, relativeTo: .caption2))
                .foregroundStyle(isCompleted ? ApexColor.textMuted : ApexColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, minHeight: 18, alignment: .leading)
        .background(palette.fill, in: .rect(cornerRadius: 3))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1).fill(palette.solid).frame(width: 3)
        }
        .clipShape(.rect(cornerRadius: 3))
        .accessibilityLabel([timeLabel, title].compactMap { $0 }.joined(separator: " "))
    }

    /// Title only. The web prefixes the time ("5:30 · Push Day"), but a phone's
    /// month cell is ~48pt wide and the time is all that survives truncation —
    /// the title is what identifies the workout; the time is one tap away.
    private var label: String { title }
}
