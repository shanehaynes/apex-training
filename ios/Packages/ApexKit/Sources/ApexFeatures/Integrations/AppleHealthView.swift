import ApexCore
import ApexUI
import SwiftUI

/// You → Apple Health (W16 M1). Writing only, for now: a workout finished in
/// the tracker is saved to Health with Apex as its source; cancelling the
/// session takes it back out.
public struct AppleHealthView: View {
    private let model: HealthModel

    public init(model: HealthModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                status
                if model.isAvailable {
                    Hint("A workout you finish in the tracker is saved to Apple Health with its real start and end, so it counts toward your rings. Apex reads nothing from Health.")
                    SettingsSection(footer: "Cancelling a finished workout removes it from Health too. Turning this off keeps what is already there.") {
                        SettingsToggle("Write workouts to Health", isOn: Binding(
                            get: { model.writesWorkouts },
                            set: { on in Task { await model.setWritesWorkouts(on) } }
                        ), identifier: "health.writeWorkouts")
                    }
                    if model.isDenied {
                        Hint("Apple Health is not letting Apex save workouts. Allow it in the Health app under Sharing › Apps › Apex, or in Settings › Health › Data Access & Devices.")
                            .accessibilityIdentifier("health.denied")
                    }
                } else {
                    Hint("Apple Health is not available on this device.")
                }
            }
            .padding(Spacing.screen)
        }
        .youScreen("Apple Health")
        .onAppear { model.refresh() }
    }

    private var status: some View {
        HStack(spacing: Spacing.md) {
            ApexIcon.heartPulse.image
                .font(.system(size: 22))
                .foregroundStyle(model.isWriting ? ApexPalette.positive : ApexColor.textMuted)
            Text(model.statusLabel)
                .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .body))
                .foregroundStyle(ApexColor.textPrimary)
                .accessibilityIdentifier("health.status")
            Spacer(minLength: 0)
        }
    }
}
