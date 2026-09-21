import ApexCore
import ApexUI
import SwiftUI

/// The month grid: up to three type-coloured dots per day and a count, tap a
/// day for its sheet, swipe for ±1 month with the web's slide.
///
/// Text chips cannot work at a phone's cell width — against real data every one
/// of them truncated to five characters ("Weig…", "Nightl…": ux-review §5), 60
/// unreadable labels on one screen. Dots show the week's shape at a glance,
/// which is what a month view is for; the day sheet carries the names.
struct MonthView: View {
    @Bindable var model: ScheduleModel
    let onOpenDay: (DayKey) -> Void
    /// Long-press on a day → the builder on that day (W7).
    var onAdd: ((DayKey) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
    /// The weekday letter row, the gap under it, and the gap at the foot.
    private let chromeHeight: CGFloat = 20 + Spacing.sm + Spacing.sm
    /// The scroll view's own height. Read off the scroll view rather than a
    /// `GeometryReader` wrapped around it: that wrapper stops the navigation
    /// stack finding the scroll view, and the large title silently stops
    /// drawing.
    @State private var viewportHeight: CGFloat = 0

    var body: some View {
        let cells = MonthGrid.cells(year: model.visibleMonth.year, month: model.visibleMonth.month, firstWeekday: model.firstWeekday)
        let rowCount = max(1, cells.count / 7)
        return ScrollView {
            VStack(spacing: Spacing.sm) {
                weekdayHeader
                grid(cells: cells, rowHeight: rowHeight(rowCount: rowCount))
                    .id("\(model.visibleMonth.year)-\(model.visibleMonth.month)")
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .move(edge: model.lastStepDirection > 0 ? .trailing : .leading).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.bottom, Spacing.sm)
            .animation(reduceMotion ? nil : .timingCurve(0.16, 1, 0.3, 1, duration: 0.28), value: model.selectedDay.monthStart)
            // Seven columns of a ~50pt cell cannot hold an accessibility-sized
            // numeral: past this the digits clip ("1:", "2("). The system
            // Calendar caps its month grid the same way, and the day sheet
            // behind a tap carries every word at full size.
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
        .background(ApexColor.bgPrimary)
        .refreshable { await model.refresh(reason: .pullToRefresh) }
        .simultaneousGesture(
            DragGesture(minimumDistance: 40).onEnded { value in
                let dx = value.translation.width, dy = value.translation.height
                guard abs(dx) > abs(dy) * 1.5, abs(dx) > 50 else { return }
                Motion.animate { model.step(dx < 0 ? 1 : -1) }
            }
        )
        .accessibilityIdentifier("schedule.month")
    }

    /// B3: the last rows rendered under the tab bar at the default text size,
    /// because every cell was `minHeight: 84` whatever the viewport. Fill the
    /// viewport instead — 44pt is the floor, and below that the grid scrolls as
    /// it always did.
    private func rowHeight(rowCount: Int) -> CGFloat {
        guard viewportHeight > 0 else { return 84 }
        return max(44, floor((viewportHeight - chromeHeight) / CGFloat(rowCount)) - 2)
    }

    private var weekdayHeader: some View {
        let letters = MonthGrid.weekdayLetters(firstWeekday: model.firstWeekday)
        return LazyVGrid(columns: columns, spacing: 2) {
            ForEach(letters.indices, id: \.self) { i in
                Text(letters[i])
                    .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                    .foregroundStyle(ApexColor.textMuted)
                    .frame(maxWidth: .infinity, minHeight: 20)
            }
        }
    }

    private func grid(cells: [DayKey?], rowHeight: CGFloat) -> some View {
        LazyVGrid(columns: columns, spacing: 2) {
            ForEach(cells.indices, id: \.self) { i in
                if let day = cells[i] {
                    MonthDayCell(
                        day: day,
                        events: model.events(on: day),
                        isToday: day == model.today,
                        height: rowHeight,
                        onOpenDay: { onOpenDay(day) },
                        onAdd: onAdd
                    )
                } else {
                    // The padding cells carry the week's hairline too, or the
                    // rule stops short of the first and last of the month.
                    Color.clear
                        .frame(height: rowHeight)
                        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 0.5) }
                }
            }
        }
    }
}

struct MonthDayCell: View {
    let day: DayKey
    let events: [ScheduleEvent]
    let isToday: Bool
    let height: CGFloat
    let onOpenDay: () -> Void
    var onAdd: ((DayKey) -> Void)? = nil

    private static let maxDots = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button(action: onOpenDay) {
                Text("\(day.day)")
                    .font(.apex(.display, size: TypeScale.xs, weight: isToday ? .bold : .medium, relativeTo: .caption))
                    .monospacedDigit()
                    // design-spec §1: accent is "here"; orange is "done" and
                    // nothing else (ux-review §3.2).
                    .foregroundStyle(isToday ? ApexColor.bgPrimary : ApexColor.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(isToday ? ApexColor.accent : .clear, in: .circle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 3)
                    .padding(.leading, 3)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            dots
            Spacer(minLength: 0)
        }
        .padding(2)
        .frame(maxWidth: .infinity, minHeight: height, alignment: .topLeading)
        // 35 bordered boxes made the grid; the numbers align themselves. A
        // hairline per week row is all the structure it needs, and only today
        // is drawn (ux-review §3.2).
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 0.5) }
        .overlay {
            if isToday {
                RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.accent.opacity(0.6), lineWidth: 1)
            }
        }
        .contentShape(.rect)
        .onTapGesture(perform: onOpenDay)
        .onLongPressGesture { onAdd?(day) }
    }

    @ViewBuilder
    private var dots: some View {
        if !events.isEmpty {
            HStack(spacing: 3) {
                ForEach(Array(events.prefix(Self.maxDots).enumerated()), id: \.offset) { _, event in
                    Circle()
                        .fill(WorkoutTypeTokens.palette(for: event.type.rawValue).solid)
                        .frame(width: 5, height: 5)
                }
                if events.count > Self.maxDots {
                    Button(action: onOpenDay) {
                        Text("+\(events.count - Self.maxDots)")
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("schedule.month.more.\(day.string)")
                }
            }
            .padding(.leading, 4)
            .frame(minHeight: 8, alignment: .leading)
        }
    }

    private var label: String {
        let date = "\(MonthNames.long[day.month - 1]) \(day.day)"
        guard !events.isEmpty else { return date }
        return "\(date), \(events.count) workout\(events.count == 1 ? "" : "s")"
    }
}
