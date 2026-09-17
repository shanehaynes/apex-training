import ApexCore
import ApexUI
import SwiftUI

/// Meals by day, pushed from You (W10): a day stepper, the server's macro
/// roll-up, one row per meal into the composer, and Add meal.
public struct MealsDayListView: View {
    @Bindable private var model: MealsModel
    @State private var composer: MealComposerRoute?

    public init(model: MealsModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                dayBar
                let day = model.meals(on: model.selectedDay)
                Text(MealsModel.rollup(day))
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(day == nil ? ApexColor.textMuted : ApexColor.textSecondary)
                    .accessibilityIdentifier("meals.rollup")
                if let meals = day?.meals, !meals.isEmpty {
                    SettingsSection {
                        ForEach(Array(meals.enumerated()), id: \.offset) { index, meal in
                            if index > 0 { SettingsDivider() }
                            Button { composer = .edit(day: model.selectedDay, item: meal) } label: {
                                MealRow(meal: meal)
                            }
                            .buttonStyle(SettingsRowButtonStyle())
                            .accessibilityIdentifier("meals.row.\(meal.id ?? String(index))")
                        }
                    }
                }
                ApexButton("Add meal", kind: .secondary) { composer = .create(model.selectedDay) }
                    .accessibilityIdentifier("meals.add")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Meals")
        .sheet(item: $composer, onDismiss: { model.flushNotice() }) { route in
            MealComposerSheet(model: model, route: route) { composer = nil }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(ApexColor.bgSurface)
        }
        .task { await model.start() }
        .task(id: model.selectedDay) { await model.loadMonth(for: model.selectedDay) }
        .refreshable { await model.loadMonth(for: model.selectedDay) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meals.root")
    }

    private var dayBar: some View {
        HStack(spacing: Spacing.sm) {
            step(ApexIcon.chevronLeft, label: "Previous day", delta: -1)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(MonthNames.weekdayLong[model.selectedDay.weekday - 1]) \(model.selectedDay.day)")
                    .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .headline))
                    .foregroundStyle(ApexColor.textPrimary)
                Text("\(MonthNames.long[model.selectedDay.month - 1]) \(String(model.selectedDay.year))")
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("meals.day")
            step(ApexIcon.chevronRight, label: "Next day", delta: 1)
            Button("Today") { Motion.animate { model.goToToday() } }
                .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                .foregroundStyle(model.selectedDay == model.today ? ApexColor.textMuted : ApexColor.textPrimary)
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 32)
                .background(ApexColor.bgSurface, in: .capsule)
                .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                .disabled(model.selectedDay == model.today)
                .frame(minHeight: 44)
        }
    }

    private func step(_ icon: ApexIcon, label: String, delta: Int) -> some View {
        Button { Motion.animate { model.select(model.selectedDay.adding(days: delta)) } } label: {
            icon.image
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ApexColor.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// One meal: the type, the title, the macros, the time.
struct MealRow: View {
    let meal: MealsQueryResult.Item

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Spacing.sm) {
                    if let type = meal.mealType {
                        Text(type.capitalized)
                            .font(.apex(.display, size: TypeScale.micro, weight: .semibold, relativeTo: .caption2))
                            .foregroundStyle(ApexColor.textPrimary)
                            .padding(.horizontal, Spacing.sm)
                            .padding(.vertical, 2)
                            .background(ApexColor.bgElevated, in: .capsule)
                    }
                    Text(meal.title)
                        .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                        .lineLimit(1)
                }
                Text(MealsModel.summary(meal))
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: Spacing.sm)
            if let time = TimeLabel.display(meal.time) {
                Text(time)
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
            ApexIcon.chevronRight.image.font(.system(size: 13, weight: .medium)).foregroundStyle(ApexColor.textMuted)
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
