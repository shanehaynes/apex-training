import SwiftUI

/// One cell of the Day view's paging week strip.
public struct WeekStripDay: Identifiable, Hashable, Sendable {
    public let id: String
    public let weekdayLetter: String
    public let dayNumber: Int
    public let isToday: Bool
    public let dots: [Color]

    public init(id: String, weekdayLetter: String, dayNumber: Int, isToday: Bool, dots: [Color]) {
        self.id = id
        self.weekdayLetter = weekdayLetter
        self.dayNumber = dayNumber
        self.isToday = isToday
        self.dots = dots
    }
}

/// The `.day-strip`: seven equal cells, a weekday letter, the number, and up to
/// three type dots. The active cell fills with the accent; today gets a ring.
public struct WeekStrip: View {
    private let days: [WeekStripDay]
    private let selectedID: String
    private let onSelect: (WeekStripDay) -> Void

    public init(days: [WeekStripDay], selectedID: String, onSelect: @escaping (WeekStripDay) -> Void) {
        self.days = days
        self.selectedID = selectedID
        self.onSelect = onSelect
    }

    public var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(days) { day in
                let isActive = day.id == selectedID
                Button { onSelect(day) } label: {
                    VStack(spacing: 3) {
                        Text(day.weekdayLetter)
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(isActive ? ApexColor.bgPrimary : ApexColor.textMuted)
                        Text("\(day.dayNumber)")
                            .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .callout))
                            .monospacedDigit()
                            .foregroundStyle(isActive ? ApexColor.bgPrimary : ApexColor.textPrimary)
                        HStack(spacing: 2) {
                            ForEach(Array(day.dots.prefix(3).enumerated()), id: \.offset) { _, color in
                                Circle().fill(isActive ? ApexColor.bgPrimary.opacity(0.7) : color).frame(width: 4, height: 4)
                            }
                        }
                        .frame(height: 4)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(isActive ? ApexColor.accent : ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.md)
                            .strokeBorder(day.isToday && !isActive ? ApexPalette.positive : ApexColor.borderSubtle, lineWidth: 1)
                    )
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(day.weekdayLetter) \(day.dayNumber)")
                .accessibilityAddTraits(isActive ? .isSelected : [])
            }
        }
    }
}
