import ApexCore
import ApexUI
import SwiftUI
import UIKit

/// The meal composer (`AddMealView.tsx`) as a sheet: favorites to fill from,
/// the placement, the type row (tapping the active type clears it), nine
/// macro fields on the decimal pad with the derived kcal as the Calories
/// placeholder, notes, and Save to library. Refusals — the form's own or the
/// server's fat-split sentence — are inline (#167); so is the library
/// notice, because the sheet stays open after it.
public struct MealComposerSheet: View {
    private let model: MealsModel
    private let route: MealComposerRoute
    private let onClose: () -> Void
    @State private var form: MealForm
    @State private var problem: String?
    @State private var isSaving = false
    @State private var confirmDelete = false

    public init(model: MealsModel, route: MealComposerRoute, onClose: @escaping () -> Void) {
        self.model = model
        self.route = route
        self.onClose = onClose
        switch route {
        case .create(let day): _form = State(initialValue: MealForm(day: day))
        case .edit(let day, let item): _form = State(initialValue: MealForm(item: item, day: day))
        }
    }

    private var editing: MealsQueryResult.Item? {
        if case .edit(_, let item) = route { return item }
        return nil
    }

    private var isDirty: Bool {
        switch route {
        case .create: !form.title.isEmpty || form.derivedCalories != nil || !form.notes.isEmpty
        case .edit(let day, let item): form != MealForm(item: item, day: day)
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: editing == nil ? "Add meal" : "Edit meal", onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    Text("\(MonthNames.weekdayLong[form.day.weekday - 1]), \(MonthNames.short[form.day.month - 1]) \(form.day.day)")
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .accessibilityIdentifier("meals.composer.day")
                    if !model.favorites.isEmpty { favoritesRow }
                    FormField("Title", text: $form.title, placeholder: "Overnight oats", identifier: "meals.composer.title")
                    HStack(spacing: Spacing.sm) {
                        DateField("Date", day: $form.day, identifier: "meals.composer.date")
                        TimeField("Time", minutes: $form.timeMinutes, identifier: "meals.composer.time")
                    }
                    typeRow
                    macros
                    FormField("Notes", text: $form.notes, placeholder: "Anything worth remembering", isMultiline: true, identifier: "meals.composer.notes")
                    if let notice = model.libraryNotice {
                        Text(notice)
                            .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(ApexPalette.positive)
                            .accessibilityIdentifier("meals.composer.librarynotice")
                    }
                }
                .padding(Spacing.screen)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(ApexColor.bgSurface)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .toolbar {
            // The decimal pad has no Return key; nine fields need a way out.
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                    .accessibilityIdentifier("meals.composer.keyboarddone")
            }
        }
        .interactiveDismissDisabled(isDirty)
        // Opened from the Schedule tab the model may never have started: the
        // favorites row needs its list. Idempotent, so the You path is unchanged.
        .task { await model.start() }
        .onChange(of: form) { _, _ in problem = nil }
        .onDisappear { model.clearLibraryNotice() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meals.composer")
    }

    /// The favorites chips: tap fills the form (everything but the placement);
    /// the ✕ removes the favorite from the library.
    private var favoritesRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("From your library").apexFieldLabel()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(model.favorites) { favorite in
                        HStack(spacing: 0) {
                            Chip(favorite.title) {
                                Motion.animate { form.apply(favorite) }
                            }
                            .accessibilityIdentifier("meals.favorite.\(favorite.id)")
                            Button {
                                Task { if let refusal = await model.deleteFavorite(favorite) { problem = refusal } }
                            } label: {
                                ApexIcon.close.image.font(.system(size: 11, weight: .medium)).foregroundStyle(ApexColor.textMuted)
                                    .frame(width: 28, height: 44).contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(favorite.title) from library")
                            .accessibilityIdentifier("meals.favorite.remove.\(favorite.id)")
                        }
                    }
                }
            }
        }
        // A container identifier would otherwise shadow the children's own (XCUITest reads the parent's).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meals.composer.favorites")
    }

    private var typeRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Type").apexFieldLabel()
            HStack(spacing: Spacing.xs) {
                ForEach(MealForm.types, id: \.self) { type in
                    Chip(type.capitalized, isSelected: form.mealType == type) {
                        Motion.animate { form.mealType = form.mealType == type ? nil : type }
                    }
                    .accessibilityAddTraits(form.mealType == type ? .isSelected : [])
                    .accessibilityIdentifier("meals.composer.type.\(type)")
                }
            }
        }
    }

    private var macros: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Macros").apexEyebrow()
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: Spacing.sm) {
                FormField("Calories", text: $form.calories, placeholder: form.derivedCalories.map(String.init) ?? "", keyboard: .decimalPad, identifier: "meals.composer.calories")
                FormField("Protein (g)", text: $form.protein, keyboard: .decimalPad, identifier: "meals.composer.protein")
                FormField("Carbs (g)", text: $form.carbs, keyboard: .decimalPad, identifier: "meals.composer.carbs")
                FormField("Fiber (g)", text: $form.fiber, keyboard: .decimalPad, identifier: "meals.composer.fiber")
                FormField("Sugar (g)", text: $form.sugar, keyboard: .decimalPad, identifier: "meals.composer.sugar")
                FormField("Total fat (g)", text: $form.fatTotal, keyboard: .decimalPad, identifier: "meals.composer.fattotal")
                FormField("Saturated (g)", text: $form.fatSaturated, keyboard: .decimalPad, identifier: "meals.composer.fatsaturated")
                FormField("Trans (g)", text: $form.fatTrans, keyboard: .decimalPad, identifier: "meals.composer.fattrans")
                FormField("Alcohol (g)", text: $form.alcohol, keyboard: .decimalPad, identifier: "meals.composer.alcohol")
            }
            Text("Calories derive 4/4/9/7 from the macros unless you type them.")
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
        }
    }

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if let problem { InlineError(problem, identifier: "meals.composer.problem") }
            if let editing, confirmDelete {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Delete “\(editing.title)”?")
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textPrimary)
                    HStack(spacing: Spacing.sm) {
                        ApexButton("Keep", kind: .secondary) { confirmDelete = false }.disabled(isSaving)
                        ApexButton("Delete meal", kind: .destructive, isLoading: isSaving) { Task { await remove(editing) } }
                            .accessibilityIdentifier("meals.composer.delete.confirm")
                    }
                }
                .padding(Spacing.md)
                .background(ApexPalette.destructive.opacity(0.12), in: .rect(cornerRadius: Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(ApexPalette.danger.opacity(0.4), lineWidth: 1))
            }
            HStack(spacing: Spacing.sm) {
                Button {
                    Task { await saveToLibrary() }
                } label: {
                    Label("Save to library", systemImage: "star")
                        .font(.apex(.display, size: TypeScale.xs, weight: .medium, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textSecondary)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(isSaving)
                .accessibilityIdentifier("meals.composer.library")
                if editing != nil, !confirmDelete {
                    Button {
                        Motion.animate { confirmDelete = true }
                    } label: {
                        ApexIcon.trash.image
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(ApexPalette.dangerText)
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving)
                    .accessibilityLabel("Delete meal")
                    .accessibilityIdentifier("meals.composer.delete")
                }
                Spacer(minLength: 0)
                ApexButton("Cancel", kind: .secondary, action: onClose).disabled(isSaving)
                ApexButton(editing == nil ? "Add meal" : "Save changes", isLoading: isSaving) { Task { await save() } }
                    .accessibilityIdentifier("meals.composer.save")
            }
        }
        .padding(Spacing.screen)
        .background(ApexColor.bgSurface)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let originalDay: DayKey? = if case .edit(let day, _) = route { day } else { nil }
        if let refusal = await model.save(form, editing: editing, originalDay: originalDay) {
            problem = refusal
        } else {
            onClose()
        }
    }

    private func saveToLibrary() async {
        isSaving = true
        defer { isSaving = false }
        if let refusal = await model.saveFavorite(form) { problem = refusal }
    }

    private func remove(_ item: MealsQueryResult.Item) async {
        isSaving = true
        defer { isSaving = false }
        if let refusal = await model.delete(item, on: route.day) { problem = refusal } else { onClose() }
    }
}
