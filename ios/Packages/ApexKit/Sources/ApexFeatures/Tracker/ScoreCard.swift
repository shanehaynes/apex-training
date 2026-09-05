import ApexCore
import ApexUI
import SwiftUI

/// `ScorePrompt.tsx`: the workout-level score a For Time / AMRAP template
/// records at Finish. Same bottom inset as the confirm bar, so the keyboard
/// lifts it (U3). "Skip score" finishes unscored.
struct ScoreCard: View {
    let model: TrackerModel

    @State private var time = ""
    @State private var rounds = ""
    @State private var reps = ""
    @State private var problem: String?
    @FocusState private var focused: Field?

    private enum Field { case time, rounds, reps }

    private var isForTime: Bool { model.event.base.scoringType == "for-time" }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(message)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if isForTime {
                field("Completion time", text: $time, placeholder: "41:32", focus: .time, keyboard: .numbersAndPunctuation)
                    .frame(maxWidth: 160)
                    .accessibilityIdentifier("tracker.score.time")
            } else {
                HStack(spacing: Spacing.sm) {
                    field("Rounds", text: $rounds, placeholder: "rounds", focus: .rounds, keyboard: .numberPad)
                        .accessibilityIdentifier("tracker.score.rounds")
                    Text("+").font(.apex(.mono, size: TypeScale.base, relativeTo: .body)).foregroundStyle(ApexColor.textMuted)
                    field("Extra reps", text: $reps, placeholder: "reps", focus: .reps, keyboard: .numberPad)
                        .accessibilityIdentifier("tracker.score.reps")
                }
                .frame(maxWidth: 260)
            }
            if let problem {
                Text(problem)
                    .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                    .foregroundStyle(ApexPalette.dangerText)
                    .accessibilityIdentifier("tracker.score.problem")
            }
            HStack(spacing: Spacing.sm) {
                ApexButton("Skip score", kind: .secondary) {
                    Task { await model.requestFinish(force: true, score: .skipped) }
                }
                ApexButton("Save score", kind: .primary) { submit() }
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.vertical, Spacing.md)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgElevated)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .onAppear {
            if isForTime {
                time = DurationBuffer.formatElapsed(model.elapsed)
                focused = .time
            } else {
                focused = .rounds
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracker.score")
    }

    private var message: String {
        if isForTime { return "Your time — this is what the PR is measured on." }
        if let cap = model.event.base.timeCapMinutes { return "Rounds + extra reps inside the \(cap) min cap." }
        return "Rounds + extra reps."
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String, focus: Field, keyboard: UIKeyboardType) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(ApexColor.textMuted))
            .font(.apex(.mono, size: TypeScale.base, relativeTo: .body))
            .foregroundStyle(ApexColor.textPrimary)
            .keyboardType(keyboard)
            .focused($focused, equals: focus)
            .padding(.horizontal, Spacing.md)
            .frame(height: 44)
            .background(ApexColor.bgSurface, in: .rect(cornerRadius: Radius.md))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
            .accessibilityLabel(label)
    }

    private func submit() {
        if isForTime {
            guard let seconds = DurationBuffer.parseDurationSeconds(time), seconds > 0 else {
                problem = "Enter the time as mm:ss"
                return
            }
            problem = nil
            Task { await model.requestFinish(force: true, score: .entered(.forTime(timeSeconds: Int(seconds.rounded())))) }
        } else {
            guard let r = Int(rounds.trimmingCharacters(in: .whitespaces)), r >= 0 else {
                problem = "Enter completed rounds"
                return
            }
            let extra = reps.trimmingCharacters(in: .whitespaces)
            let e: Int
            if extra.isEmpty {
                e = 0
            } else if let parsed = Int(extra), parsed >= 0 {
                e = parsed
            } else {
                problem = "Extra reps must be a number"
                return
            }
            problem = nil
            Task { await model.requestFinish(force: true, score: .entered(.amrap(rounds: r, reps: e))) }
        }
    }
}
