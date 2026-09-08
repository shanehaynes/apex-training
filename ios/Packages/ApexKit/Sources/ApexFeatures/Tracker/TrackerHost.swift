import ApexCore
import ApexUI
import SwiftUI

/// The `fullScreenCover` root: owns the model for one presentation and keeps
/// the screen awake while it is up (U15). The tracker is a mode, like the
/// web's fixed overlay — rotating or backgrounding never dismisses it.
public struct TrackerHost: View {
    @State private var model: TrackerModel
    @Environment(\.dismiss) private var dismiss

    public init(route: TrackerRoute, deps: TrackerDependencies) {
        _model = State(initialValue: TrackerModel(event: route.event, deps: deps))
    }

    public var body: some View {
        TrackerScreen(model: model) {
            Task {
                await model.close()
                dismiss()
            }
        }
        .task { await model.open() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
