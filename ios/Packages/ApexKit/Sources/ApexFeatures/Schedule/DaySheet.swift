import ApexCore
import ApexUI
import SwiftUI

/// The day sheet (`DayModal.tsx`): the day's workouts as full cards — this is
/// where a month cell's completion control lives (U7) — and the meals with the
/// server's macro roll-up.
public struct DaySheet: View {
    let model: ScheduleModel
    let day: DayKey
    let onOpenEvent: (ScheduleEvent) -> Void
    let onClose: () -> Void

    public init(model: ScheduleModel, day: DayKey, onOpenEvent: @escaping (ScheduleEvent) -> Void, onClose: @escaping () -> Void) {
        self.model = model
        self.day = day
        self.onOpenEvent = onOpenEvent
        self.onClose = onClose
    }

    public var body: some View {
        let events = model.events(on: day)
        let meals = model.meals(on: day)
        VStack(spacing: 0) {
            SheetHeader(title: "\(MonthNames.weekdayLong[day.weekday - 1])", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(MonthNames.long[day.month - 1]) \(day.day), \(String(day.year))")
                            .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                            .foregroundStyle(ApexColor.textMuted)
                        Text(countLine(events: events.count, meals: meals?.mealCount ?? 0))
                            .apexBody()
                    }
                    if events.isEmpty {
                        Text("No workouts scheduled — rest up.").apexBody()
                    } else {
                        VStack(spacing: Spacing.sm) {
                            ForEach(events) { event in
                                EventCardRow(model: model, event: event, onOpen: { onOpenEvent(event) })
                            }
                        }
                    }
                    MealsSection(day: meals)
                }
                .padding(.horizontal, Spacing.screen)
                .padding(.vertical, Spacing.md)
            }
        }
        .background(ApexColor.bgSurface)
        .task { await model.loadMeals(for: day) }
        .accessibilityIdentifier("schedule.daysheet")
    }

    private func countLine(events: Int, meals: Int) -> String {
        let workouts = events == 0 ? "No workouts" : "\(events) workout\(events == 1 ? "" : "s")"
        return meals == 0 ? workouts : "\(workouts) · \(meals) meal\(meals == 1 ? "" : "s")"
    }
}

/// Totals line then one row per meal (`mealSummary` on the web).
struct MealsSection: View {
    let day: MealsQueryResult.Day?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Meals").apexEyebrow()
            if let day, day.mealCount > 0 {
                Text("\(Int(day.totals.calories)) kcal / \(grams(day.totals.proteinG)) g protein / \(grams(day.totals.carbsG)) g carbs / \(grams(day.totals.fatTotalG)) g fat")
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textSecondary)
                ForEach(Array((day.meals ?? []).enumerated()), id: \.offset) { _, meal in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        if let type = meal.mealType {
                            Text(type.capitalized)
                                .font(.apex(.display, size: TypeScale.micro, weight: .semibold, relativeTo: .caption2))
                                .foregroundStyle(ApexColor.textPrimary)
                                .padding(.horizontal, Spacing.sm)
                                .padding(.vertical, 2)
                                .background(ApexColor.bgElevated, in: .capsule)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(meal.title)
                                .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                                .foregroundStyle(ApexColor.textPrimary)
                            Text(summary(meal))
                                .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                        Spacer()
                        if let time = TimeLabel.display(meal.time) {
                            Text(time)
                                .font(.apex(.mono, size: TypeScale.micro, relativeTo: .caption2))
                                .foregroundStyle(ApexColor.textMuted)
                        }
                    }
                    .padding(.vertical, Spacing.xs)
                }
            } else {
                Text("No meals logged").apexBody()
            }
        }
    }

    private func summary(_ meal: MealsQueryResult.Item) -> String {
        var parts: [String] = []
        if let c = meal.calories { parts.append("\(Int(c)) kcal") }
        let macros = [("P", meal.proteinG), ("C", meal.carbsG), ("F", meal.fatTotalG)].compactMap { label, value in
            value.map { "\(label) \(grams($0))" }
        }
        if !macros.isEmpty { parts.append(macros.joined(separator: " / ")) }
        return parts.joined(separator: " · ")
    }

    private func grams(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}
