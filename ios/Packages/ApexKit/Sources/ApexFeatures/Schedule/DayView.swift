import ApexCore
import ApexUI
import SwiftUI

/// The default surface: a week strip, the big date, the day's cards with their
/// 44pt completion controls, and the meals line. Swipe the strip for ±1 week,
/// the body for ±1 day (U6 — the web has no gestures at all).
struct DayView: View {
    @Bindable var model: ScheduleModel
    let onOpen: (ScheduleEvent) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                weekStrip
                header
                    .id(model.selectedDay)
                    .transition(.asymmetric(
                        insertion: .move(edge: model.lastStepDirection > 0 ? .trailing : .leading).combined(with: .opacity),
                        removal: .opacity
                    ))
                eventList
                MealsRow(day: model.meals(on: model.selectedDay))
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.bottom, Spacing.xxl)
            .animation(Motion.spring, value: model.selectedDay)
        }
        .background(ApexColor.bgPrimary)
        .refreshable { await model.refresh(reason: .pullToRefresh) }
        .simultaneousGesture(swipe(days: 1))
        .task(id: model.selectedDay) { await model.loadMeals(for: model.selectedDay) }
        .accessibilityIdentifier("schedule.day")
    }

    private var weekStrip: some View {
        let days = WeekPage.days(containing: model.selectedDay, firstWeekday: model.firstWeekday).map { day in
            WeekStripDay(
                id: day.string,
                weekdayLetter: MonthNames.weekdayLetters[day.weekday - 1],
                dayNumber: day.day,
                isToday: day == model.today,
                dots: model.typeDots(on: day).map { WorkoutTypeTokens.palette(for: $0.rawValue).solid }
            )
        }
        return WeekStrip(days: days, selectedID: model.selectedDay.string) { picked in
            if let day = DayKey(picked.id) { withAnimation(Motion.spring) { model.select(day) } }
        }
        .padding(.top, Spacing.xs)
        .simultaneousGesture(swipe(days: 7))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
            Text("\(model.selectedDay.day)")
                .font(.apex(.display, size: 42, weight: .bold, relativeTo: .largeTitle))
                .tracking(-1.7)
                .foregroundStyle(ApexColor.textPrimary)
                .monospacedDigit()
            VStack(alignment: .leading, spacing: 2) {
                Text(MonthNames.weekdayLong[model.selectedDay.weekday - 1])
                    .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .headline))
                    .foregroundStyle(ApexColor.textPrimary)
                Text("\(MonthNames.long[model.selectedDay.month - 1]) \(String(model.selectedDay.year))")
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            Spacer()
            if model.selectedDay == model.today {
                Text("Today")
                    .apexEyebrow()
                    .foregroundStyle(ApexPalette.positive)
                    .padding(.horizontal, Spacing.sm)
                    .padding(.vertical, 3)
                    .overlay(Capsule().strokeBorder(ApexPalette.positive.opacity(0.5), lineWidth: 1))
            }
        }
    }

    @ViewBuilder
    private var eventList: some View {
        let events = model.events(on: model.selectedDay)
        if events.isEmpty {
            Text("No workouts scheduled — rest up.")
                .apexBody()
                .frame(maxWidth: .infinity, minHeight: 88)
                .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexColor.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
                .accessibilityIdentifier("schedule.day.empty")
        } else {
            VStack(spacing: Spacing.sm) {
                ForEach(events) { event in
                    EventCardRow(model: model, event: event, onOpen: { onOpen(event) })
                }
            }
        }
    }

    private func swipe(days: Int) -> some Gesture {
        DragGesture(minimumDistance: 40, coordinateSpace: .local).onEnded { value in
            let dx = value.translation.width, dy = value.translation.height
            guard abs(dx) > abs(dy) * 1.5, abs(dx) > 50 else { return }
            withAnimation(Motion.spring) {
                if days == 1 { model.step(dx < 0 ? 1 : -1) } else { model.select(model.selectedDay.adding(days: dx < 0 ? days : -days)) }
            }
        }
    }
}

/// An `EventCard` bound to the model's live event, with the haptic on toggle.
struct EventCardRow: View {
    let model: ScheduleModel
    let event: ScheduleEvent
    let onOpen: () -> Void

    var body: some View {
        EventCard(
            rawType: event.type.rawValue,
            title: event.title,
            subtitle: event.base.subtitle,
            timeLabel: TimeLabel.display(event.startTime),
            durationLabel: event.estimatedDuration.map { TimeLabel.duration(minutes: $0) },
            isCompleted: event.isCompleted,
            onOpen: onOpen,
            onToggle: {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Task { await model.toggleCompletion(event) }
            }
        )
    }
}

/// `"1114 kcal · P 70 / C 138 / F 30 · 2 meals"` — sums the server made.
struct MealsRow: View {
    let day: MealsQueryResult.Day?

    var body: some View {
        HStack(spacing: Spacing.sm) {
            ApexIcon.utensils.image
                .font(.system(size: 13))
                .foregroundStyle(ApexColor.textMuted)
            Text(summary)
                .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(day == nil ? ApexColor.textMuted : ApexColor.textSecondary)
            Spacer()
        }
        .padding(.horizontal, Spacing.md)
        .frame(minHeight: 40)
        .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
        .accessibilityIdentifier("schedule.meals")
    }

    private var summary: String {
        guard let day, day.mealCount > 0 else { return "No meals logged" }
        let t = day.totals
        return "\(Int(t.calories)) kcal · P \(grams(t.proteinG)) / C \(grams(t.carbsG)) / F \(grams(t.fatTotalG)) · \(day.mealCount) meal\(day.mealCount == 1 ? "" : "s")"
    }

    private func grams(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}
