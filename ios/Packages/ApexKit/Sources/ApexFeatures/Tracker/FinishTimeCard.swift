import ApexCore
import ApexUI
import SwiftUI

/// `FinishTimePrompt.tsx` (D-061): the Finish step for a session that ran far
/// past its plan — when did it really end? Prefilled with the last logged set
/// (or the start plus the plan); the athlete's answer wins either way, and
/// "It ran …" is the same one tap as accepting the default. Same bottom inset
/// as the confirm bar.
struct FinishTimeCard: View {
    let model: TrackerModel
    let runaway: RunawayFinish

    @State private var end: Date
    /// When the card opened: the instant its elapsed time was read.
    @State private var now: Date

    init(model: TrackerModel, runaway: RunawayFinish) {
        self.model = model
        self.runaway = runaway
        _end = State(initialValue: runaway.suggestion.at)
        _now = State(initialValue: max(runaway.suggestion.at, model.services.clock.now))
    }

    private var start: Date { model.startedAt ?? runaway.suggestion.at }
    /// The tracker's clock ticks each second, so a card left open keeps the
    /// real length and lets the athlete pick the current minute.
    private var liveNow: Date { max(now, start.addingTimeInterval(TimeInterval(model.elapsed))) }
    private var elapsedLabel: String {
        RunawayFinish.formatLength(seconds: max(runaway.elapsedSeconds, Double(model.elapsed)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("This session has run \(elapsedLabel) against a \(RunawayFinish.formatLength(seconds: runaway.plannedMinutes * 60)) plan. When did it end?")
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            DatePicker("Ended", selection: $end, in: start...liveNow, displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.compact)
                .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                .foregroundStyle(ApexColor.textSecondary)
                .accessibilityIdentifier("tracker.finish-time.picker")
            Text(runaway.suggestion.basis == .lastLogged
                 ? "Prefilled with when your last set was saved."
                 : "Nothing logged yet — prefilled with the start plus the plan.")
                .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                .foregroundStyle(ApexColor.textMuted)
            ApexButton("Finish at \(timeLabel)", kind: .primary) {
                Task { await model.finish(at: .at(end)) }
            }
            .accessibilityIdentifier("tracker.finish-time.finish")
            HStack(spacing: Spacing.sm) {
                ApexButton("Keep going", kind: .secondary) { model.keepGoing() }
                    .accessibilityIdentifier("tracker.finish-time.keep")
                ApexButton("It ran \(elapsedLabel)", kind: .secondary) {
                    Task { await model.finish(at: .asRecorded) }
                }
                .accessibilityIdentifier("tracker.finish-time.as-recorded")
            }
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.vertical, Spacing.md)
        .frame(maxWidth: .infinity)
        .background(ApexColor.bgElevated)
        .overlay(alignment: .top) { Rectangle().fill(ApexColor.borderSubtle).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tracker.finish-time")
    }

    /// "10:46 PM" today, "Sep 2, 10:46 PM" on another day.
    private var timeLabel: String {
        Calendar.current.isDate(end, inSameDayAs: liveNow)
            ? end.formatted(date: .omitted, time: .shortened)
            : end.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
