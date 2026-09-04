import ApexCore
import ApexUI
import SwiftUI

/// The month grid: ≤3 chips per day and a `+N`, tap a day for its sheet, tap a
/// chip for the event, swipe for ±1 month with the web's slide.
struct MonthView: View {
    @Bindable var model: ScheduleModel
    let onOpenDay: (DayKey) -> Void
    let onOpenEvent: (ScheduleEvent) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.sm) {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(MonthGrid.weekdayLetters(firstWeekday: model.firstWeekday).indices, id: \.self) { i in
                        Text(MonthGrid.weekdayLetters(firstWeekday: model.firstWeekday)[i])
                            .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textMuted)
                            .frame(maxWidth: .infinity, minHeight: 20)
                    }
                }
                grid
                    .id("\(model.visibleMonth.year)-\(model.visibleMonth.month)")
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .move(edge: model.lastStepDirection > 0 ? .trailing : .leading).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.bottom, Spacing.xxl)
            .animation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.28), value: model.selectedDay.monthStart)
        }
        .background(ApexColor.bgPrimary)
        .refreshable { await model.refresh(reason: .pullToRefresh) }
        .simultaneousGesture(
            DragGesture(minimumDistance: 40).onEnded { value in
                let dx = value.translation.width, dy = value.translation.height
                guard abs(dx) > abs(dy) * 1.5, abs(dx) > 50 else { return }
                withAnimation { model.step(dx < 0 ? 1 : -1) }
            }
        )
        .accessibilityIdentifier("schedule.month")
    }

    private var grid: some View {
        let cells = MonthGrid.cells(year: model.visibleMonth.year, month: model.visibleMonth.month, firstWeekday: model.firstWeekday)
        return LazyVGrid(columns: columns, spacing: 2) {
            ForEach(cells.indices, id: \.self) { i in
                if let day = cells[i] {
                    MonthDayCell(
                        day: day,
                        events: model.events(on: day),
                        isToday: day == model.today,
                        onOpenDay: { onOpenDay(day) },
                        onOpenEvent: onOpenEvent
                    )
                } else {
                    Color.clear.frame(minHeight: 84)
                }
            }
        }
    }
}

struct MonthDayCell: View {
    let day: DayKey
    let events: [ScheduleEvent]
    let isToday: Bool
    let onOpenDay: () -> Void
    let onOpenEvent: (ScheduleEvent) -> Void

    private static let maxVisible = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: onOpenDay) {
                Text("\(day.day)")
                    .font(.apex(.display, size: TypeScale.xs, weight: isToday ? .bold : .medium, relativeTo: .caption))
                    .monospacedDigit()
                    .foregroundStyle(isToday ? ApexColor.bgPrimary : ApexColor.textSecondary)
                    .frame(width: 22, height: 22)
                    .background(isToday ? ApexPalette.positive : .clear, in: .circle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 3)
                    .padding(.leading, 3)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(MonthNames.long[day.month - 1]) \(day.day)")

            ForEach(events.prefix(Self.maxVisible)) { event in
                Button { onOpenEvent(event) } label: {
                    EventChip(
                        rawType: event.type.rawValue,
                        title: event.title,
                        timeLabel: TimeLabel.display(event.startTime),
                        isCompleted: event.isCompleted
                    )
                }
                .buttonStyle(.plain)
            }
            if events.count > Self.maxVisible {
                Button(action: onOpenDay) {
                    Text("+\(events.count - Self.maxVisible) more")
                        .font(.apex(.display, size: 10, weight: .semibold, relativeTo: .caption2))
                        .foregroundStyle(ApexPalette.positive)
                        .padding(.leading, 4)
                        .frame(maxWidth: .infinity, minHeight: 16, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("schedule.month.more.\(day.string)")
            }
            Spacer(minLength: 0)
        }
        .padding(2)
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.sm))
        .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(ApexColor.borderSubtle, lineWidth: 0.5))
        .contentShape(.rect)
        .onTapGesture(perform: onOpenDay)
    }
}
