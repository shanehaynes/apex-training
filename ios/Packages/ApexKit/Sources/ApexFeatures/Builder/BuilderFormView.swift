import ApexCore
import ApexUI
import SwiftUI

/// `BuilderForm.tsx`, reordered by ux-review §3.5: the user names the thing
/// first, then says what kind it is, then when it happens, then what is in it.
/// Type is a menu (7 options — `collapseAbove: 4`), sport is present only when
/// it means something, and the rarely-touched half of the form — scoring,
/// repeat, location, tags, difficulty, description — lives under "More
/// options", which opens itself whenever any of it is already set.
struct BuilderFormView: View {
    @Bindable var builder: BuilderModel

    /// nil = follow the draft (`hasMoreSet`); a tap latches the user's choice.
    /// Latching rather than seeding a `Bool` keeps the disclosure honest when
    /// the coach fills the form after the view is on screen.
    @State private var moreOpenOverride: Bool?

    private var draft: WorkoutDraft { builder.draft }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                FormField("Title", text: field(\.title), placeholder: "Leg day", identifier: "builder.title.field")
                ChipRow("Type", options: WorkoutDraft.typeOrder.map { ($0, WorkoutDraft.label(for: $0)) },
                        selection: Binding(get: { draft.type }, set: { builder.setType($0) }),
                        collapseAbove: 4, identifier: "builder.type")
                if showsSport {
                    ChipRow("Sport", options: WorkoutDraft.sportOptions.map { ($0.value, $0.label) }, selection: field(\.sport), identifier: "builder.sport")
                }
                DateField(builder.asksScope ? "Date (this event only)" : "Date", day: dayBinding, identifier: "builder.date")
                HStack(spacing: Spacing.sm) {
                    FormField("Duration (min)", text: field(\.duration), placeholder: "60", keyboard: .numberPad, identifier: "builder.duration")
                }
                HStack(spacing: Spacing.sm) {
                    TimeField("Start", minutes: timeBinding(\.startTime), identifier: "builder.start")
                    TimeField("End", minutes: timeBinding(\.endTime), identifier: "builder.end")
                }
                if draft.type == .outdoorClimbing {
                    HStack(spacing: Spacing.sm) {
                        FormField("Max grade", text: field(\.maxGrade), placeholder: "5.11a", identifier: "builder.maxgrade")
                        FormField("Total pitches", text: field(\.totalPitches), placeholder: "4", keyboard: .numberPad, identifier: "builder.pitches")
                    }
                }
                if draft.type == .cardio {
                    HStack(spacing: Spacing.sm) {
                        FormField("Mileage", text: field(\.distance), placeholder: "5 mi", identifier: "builder.distance")
                        FormField("Elevation gain", text: field(\.elevationGain), placeholder: "800 ft", identifier: "builder.elevation")
                    }
                    FormField("Avg heart rate", text: field(\.avgHeartRate), placeholder: "150", keyboard: .numberPad, identifier: "builder.hr")
                }
                moreOptions
                exercises
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.top, Spacing.md)
            .padding(.bottom, Spacing.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("builder.form")
    }

    // MARK: - Conditional presence

    /// Sport is a cardio question (`sportOptions` is running / biking /
    /// swimming / other). Climbing types set it themselves in `withType`, and
    /// everything else has no use for it — so it is *absent*, not collapsed.
    /// The one exception keeps an edit form honest: a draft that already
    /// carries a sport shows the field whatever its type, so no existing event
    /// can hide a value the user cannot then see or clear.
    private var showsSport: Bool {
        if draft.isClimbingType { return false }
        return draft.type == .cardio || !draft.sport.isEmpty
    }

    // MARK: - More options

    private var isMoreOpen: Bool { moreOpenOverride ?? hasMoreSet }

    /// Anything under the disclosure that is not at its `empty(date:)` default.
    /// Computed from the draft on every read rather than stored, so a coach
    /// reduce or a picked template opens the section the same way a loaded
    /// event does.
    private var hasMoreSet: Bool {
        draft.scoringType != "strength"
            || !draft.timeCap.isEmpty
            || draft.repeatRule.enabled
            || draft.repeatRule.custom != nil
            || !draft.location.isEmpty
            || !draft.tags.isEmpty
            || !draft.description.isEmpty
            || draft.difficulty != 3
    }

    private var moreOptions: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Button {
                Motion.animate { moreOpenOverride = !isMoreOpen }
            } label: {
                HStack(spacing: Spacing.sm) {
                    Text("More options").apexFieldLabel()
                    ApexIcon.chevronDown.image
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ApexColor.textMuted)
                        .rotationEffect(.degrees(isMoreOpen ? 0 : -90))
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("More options")
            .accessibilityValue(isMoreOpen ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("builder.more")

            if isMoreOpen {
                ChipRow("Scoring", options: WorkoutDraft.scoringOptions.map { ($0.value, $0.label) }, selection: field(\.scoringType), identifier: "builder.scoring")
                if draft.scoringType == "amrap" {
                    FormField("Time cap (min)", text: field(\.timeCap), placeholder: "20", keyboard: .numberPad, identifier: "builder.timecap")
                }
                RepeatPickerView(
                    repeatRule: Binding(get: { draft.repeatRule }, set: { value in builder.update { $0.repeatRule = value } }),
                    anchorDate: draft.date, lockOff: builder.asksScope
                )
                FormField("Location", text: field(\.location), placeholder: "East Rock", identifier: "builder.location")
                FormField("Tags", text: field(\.tags), placeholder: "legs, heavy", identifier: "builder.tags")
                difficulty
                FormField("Description", text: field(\.description), placeholder: "What this session is for", isMultiline: true, identifier: "builder.description")
            }
        }
    }

    private var difficulty: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Difficulty").apexFieldLabel()
            HStack(spacing: Spacing.sm) {
                HStack(spacing: 0) {
                    ForEach(1...5, id: \.self) { i in
                        Button { builder.update { $0.difficulty = i } } label: {
                            Circle()
                                .fill(i <= draft.difficulty ? WorkoutTypeTokens.palette(for: draft.type.rawValue).solid : ApexColor.bgElevated)
                                .overlay(Circle().strokeBorder(i <= draft.difficulty ? .clear : ApexColor.borderSubtle, lineWidth: 1))
                                .frame(width: 12, height: 12)
                                .frame(width: 24, height: 44)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Difficulty \(i) — \(WorkoutDraft.difficultyLabels[i])")
                        .accessibilityIdentifier("builder.difficulty.\(i)")
                    }
                }
                Text(WorkoutDraft.difficultyLabels[max(0, min(5, draft.difficulty))])
                    .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexColor.textMuted)
            }
        }
    }

    private var exercises: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Exercises").apexFieldLabel()
            ExerciseSectionsEditor(
                lists: Binding(get: { draft.lists }, set: { value in builder.update { $0.lists = value } }),
                workoutType: draft.type, definitions: builder.definitions, errors: builder.errors,
                onCreateDefinition: { name, category, unilateral in await builder.createDefinition(name: name, category: category, isUnilateral: unilateral) }
            )
            .frame(minHeight: 520)
        }
    }

    private func field(_ keyPath: WritableKeyPath<WorkoutDraft, String>) -> Binding<String> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in builder.update { $0[keyPath: keyPath] = value } })
    }

    private var dayBinding: Binding<DayKey> {
        Binding(get: { DayKey(draft.date) ?? DayKey(year: 2026, month: 1, day: 1) }, set: { day in builder.update { $0.date = day.string } })
    }

    /// `HH:mm` in the draft ↔ minutes in the picker; empty = unset.
    private func timeBinding(_ keyPath: WritableKeyPath<WorkoutDraft, String>) -> Binding<Int?> {
        Binding(
            get: { TimeLabel.minutes(draft[keyPath: keyPath]) },
            set: { minutes in builder.update { $0[keyPath: keyPath] = minutes.map { String(format: "%02d:%02d", $0 / 60, $0 % 60) } ?? "" } }
        )
    }
}
