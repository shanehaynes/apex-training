import ApexCore
import ApexUI
import SwiftUI

/// `BuilderForm.tsx`, field for field: type chips (through `withType`), sport
/// (hidden for climbing types), scoring (+ the AMRAP cap), title, date,
/// duration, start/end, repeat, the climbing or cardio targets, location,
/// tags, description, difficulty, and the sections editor.
struct BuilderFormView: View {
    @Bindable var builder: BuilderModel

    private var draft: WorkoutDraft { builder.draft }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ChipRow("Type", options: WorkoutDraft.typeOrder.map { ($0, WorkoutDraft.label(for: $0)) },
                        selection: Binding(get: { draft.type }, set: { builder.setType($0) }), identifier: "builder.type")
                if !draft.isClimbingType {
                    ChipRow("Sport", options: WorkoutDraft.sportOptions.map { ($0.value, $0.label) }, selection: field(\.sport), identifier: "builder.sport")
                }
                ChipRow("Scoring", options: WorkoutDraft.scoringOptions.map { ($0.value, $0.label) }, selection: field(\.scoringType), identifier: "builder.scoring")
                if draft.scoringType == "amrap" {
                    FormField("Time cap (min)", text: field(\.timeCap), placeholder: "20", keyboard: .numberPad, identifier: "builder.timecap")
                }
                FormField("Title", text: field(\.title), placeholder: "Leg day", identifier: "builder.title.field")
                DateField(builder.asksScope ? "Date (this event only)" : "Date", day: dayBinding, identifier: "builder.date")
                HStack(spacing: Spacing.sm) {
                    FormField("Duration (min)", text: field(\.duration), placeholder: "60", keyboard: .numberPad, identifier: "builder.duration")
                }
                HStack(spacing: Spacing.sm) {
                    TimeField("Start", minutes: timeBinding(\.startTime), identifier: "builder.start")
                    TimeField("End", minutes: timeBinding(\.endTime), identifier: "builder.end")
                }
                RepeatPickerView(
                    repeatRule: Binding(get: { draft.repeatRule }, set: { value in builder.update { $0.repeatRule = value } }),
                    anchorDate: draft.date, lockOff: builder.asksScope
                )
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
                FormField("Location", text: field(\.location), placeholder: "East Rock", identifier: "builder.location")
                FormField("Tags", text: field(\.tags), placeholder: "legs, heavy", identifier: "builder.tags")
                FormField("Description", text: field(\.description), placeholder: "What this session is for", isMultiline: true, identifier: "builder.description")
                difficulty
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
