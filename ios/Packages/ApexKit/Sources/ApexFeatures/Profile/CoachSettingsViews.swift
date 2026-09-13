import ApexCore
import ApexUI
import SwiftUI

/// Goal and context, with the web's rotating ghost-text examples; saved when
/// the form loses focus or the screen is left. Clearing is a save.
public struct CoachProfileView: View {
    private let model: YouModel
    @State private var goal: String
    @State private var context: String
    @State private var error: String?
    @State private var goalPlaceholder = RotatingPlaceholder(Self.goalExamples)
    @State private var contextPlaceholder = RotatingPlaceholder(Self.contextExamples, offset: .seconds(4))
    @FocusState private var focus: Field?

    private enum Field { case goal, context }

    static let goalExamples = [
        "Summit Everest",
        "Win a local bodybuilding competition",
        "Climb 5.13a",
        "Run a sub-3-hour marathon",
    ]
    static let contextExamples = [
        "I am 54 with a history of lower back pain",
        "I am a sprinter with shin splints",
        "I am trying to fix a muscular asymmetry",
    ]

    public init(model: YouModel) {
        self.model = model
        _goal = State(initialValue: model.profile?.coachGoal ?? "")
        _context = State(initialValue: model.profile?.coachContext ?? "")
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Tell the coach what you're training for — it shapes every chat and post-workout summary.")
                FormField("Goal", text: $goal, placeholder: goalPlaceholder.current, identifier: "you.coach.goal")
                    .focused($focus, equals: .goal)
                    .submitLabel(.next)
                    .onSubmit { focus = .context }
                FormField("Additional context", text: $context, placeholder: contextPlaceholder.current, isMultiline: true, identifier: "you.coach.context")
                    .focused($focus, equals: .context)
                if let error { InlineError(error) }
                ApexButton("Save", kind: .secondary) { focus = nil; Task { await save() } }
                    .accessibilityIdentifier("you.coach.save")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Goal & context")
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focus = nil }
                    .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
            }
        }
        .onChange(of: focus) { _, field in
            if field == nil { Task { await save() } }
        }
        .task { await goalPlaceholder.run() }
        .task { await contextPlaceholder.run() }
    }

    private func save() async {
        error = await model.saveCoachProfile(goal: goal, context: context)
    }
}

/// `useRotatingPlaceholder`: the first swap fires at period + offset, then
/// every period. Two instances with different offsets never swap together.
@MainActor
@Observable
final class RotatingPlaceholder {
    private let examples: [String]
    private let period: Duration
    private let offset: Duration
    private var index = 0

    init(_ examples: [String], period: Duration = .seconds(8), offset: Duration = .zero) {
        self.examples = examples
        self.period = period
        self.offset = offset
    }

    var current: String { examples.isEmpty ? "" : examples[index % examples.count] }

    func run() async {
        guard examples.count > 1 else { return }
        try? await Task.sleep(for: period + offset)
        while !Task.isCancelled {
            index = (index + 1) % examples.count
            try? await Task.sleep(for: period)
        }
    }
}

/// Which Claude model the coach runs on — the one control that changes what
/// the user pays, so every option carries its $/MTok (`CoachModelPicker.tsx`).
/// The catalog is the server's (D-008); nothing here knows a model id.
public struct CoachModelPickerView: View {
    private let model: YouModel

    public init(model: YouModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Billed to your own Anthropic key. The pick applies everywhere the coach speaks: chat, the builder, post-workout summaries and the monthly review.")
                if let models = model.profile?.coachModels {
                    SettingsSection {
                        ForEach(Array(models.enumerated()), id: \.element.id) { index, option in
                            if index > 0 { SettingsDivider() }
                            Button {
                                Task { await model.saveCoachModel(option.id) }
                            } label: {
                                row(option, isSelected: option.id == model.selectedModel?.id)
                            }
                            .buttonStyle(SettingsRowButtonStyle())
                            .accessibilityAddTraits(option.id == model.selectedModel?.id ? .isSelected : [])
                            .accessibilityIdentifier("you.model.\(option.id)")
                        }
                    }
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Coach model")
    }

    private func row(_ option: ProfileResponse.CoachModelOption, isSelected: Bool) -> some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Spacing.sm) {
                    Text(option.label)
                        .font(.apex(.display, size: TypeScale.base, weight: .medium, relativeTo: .body))
                        .foregroundStyle(ApexColor.textPrimary)
                    Text(option.priceLabel)
                        .font(.apex(.mono, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                }
                Text(option.blurb)
                    .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                    .foregroundStyle(ApexColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if isSelected {
                ApexIcon.check.image
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ApexPalette.positive)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .frame(minHeight: 48)
        .contentShape(.rect)
    }
}
