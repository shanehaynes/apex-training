import ApexCore
import ApexUI
import SwiftUI

/// The `fullScreenCover` root: owns the model for one presentation and keeps
/// the screen awake while it is up (U15). The tracker is a mode, like the
/// web's fixed overlay — rotating or backgrounding never dismisses it.
///
/// It is also the only place that knows both the session and its start, so it
/// is what publishes them to `LiveSessionStore` for the schedule to draw.
public struct TrackerHost: View {
    @State private var model: TrackerModel
    private let live: LiveSessionStore
    private let clock: any ApexClock
    @Environment(\.dismiss) private var dismiss

    public init(route: TrackerRoute, deps: TrackerDependencies) {
        _model = State(initialValue: TrackerModel(event: route.event, deps: deps))
        live = deps.services.live
        clock = deps.services.clock
    }

    /// Started and nothing has ended it. `.cancelling` is the one gate that
    /// does not come back: `cancelWorkout` purges the session and only leaves
    /// the gate on a failure, where the next render puts the timer back.
    private var isRunning: Bool {
        model.startedAt != nil && !model.isFinished && model.gate != .cancelling
    }

    /// The start, moved into the frame of the clock that will *tick* it.
    ///
    /// `Text(timerInterval:)` is driven by the system, not by the injected
    /// `ApexClock` — so a session whose stamp comes from a fixed clock (the
    /// mock's 2026-09-08, the snapshot suite's) would count from that date
    /// and read 325 hours instead of 7 minutes. Shifting by the same offset
    /// preserves the elapsed the tracker itself shows and is the identity
    /// under `SystemClock`, which is what ships.
    private var displayStart: Date? {
        model.startedAt.map { Date().addingTimeInterval(-clock.now.timeIntervalSince($0)) }
    }

    public var body: some View {
        TrackerScreen(model: model) {
            Task {
                await model.close()
                // Back is not "done": publish *after* the close so the card
                // picks the session up, and after a cancel so it does not.
                publish()
                dismiss()
            }
        }
        .task {
            await model.open()
            publish()
        }
        .onChange(of: model.startedAt) { _, _ in publish() }
        .onChange(of: model.isFinished) { _, _ in publish() }
        .onChange(of: model.gate) { _, _ in publish() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private func publish() {
        live.reflect(model.session, startedAt: displayStart, isRunning: isRunning)
    }
}
