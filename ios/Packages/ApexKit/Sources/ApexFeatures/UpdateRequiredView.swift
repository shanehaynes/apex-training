import ApexUI
import SwiftUI

/// The blocking screen a build below the server's floor gets instead of the
/// app (G8, `UpdateGate` in ApexCore).
///
/// There is deliberately no way past it and no retry button: the verdict came
/// from a successful read of `/api/version`, so the only thing that changes it
/// is installing a newer build. Everything that could have gone wrong on the
/// way to that verdict — offline, a 500, an unreadable body — already failed
/// open in `UpdateGate` and never reaches this screen.
public struct UpdateRequiredView: View {
    private let message: String
    private let appStore: URL?

    /// `appStore` is where "Update Apex" goes; nil (no App Store listing yet)
    /// states the requirement without offering a dead link.
    public init(message: String, appStore: URL? = nil) {
        self.message = message
        self.appStore = appStore
    }

    public var body: some View {
        ZStack {
            ApexColor.bgPrimary.ignoresSafeArea()
            VStack(spacing: Spacing.xl) {
                Wordmark()

                VStack(spacing: Spacing.md) {
                    Text("Update required")
                        .font(.apex(.display, size: TypeScale.xl, weight: .semibold, relativeTo: .title2))
                        .foregroundStyle(ApexColor.textPrimary)

                    Text(message)
                        .font(.apex(.display, size: TypeScale.sm, relativeTo: .callout))
                        .foregroundStyle(ApexColor.textSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let appStore {
                    Link(destination: appStore) {
                        Text("Update Apex")
                            .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
                            .foregroundStyle(ApexColor.bgPrimary)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(ApexColor.accent, in: .rect(cornerRadius: Radius.md))
                    }
                    .accessibilityIdentifier("update.appstore")
                } else {
                    Text("Install the latest build to continue.")
                        .font(.apex(.display, size: TypeScale.xs, relativeTo: .caption))
                        .foregroundStyle(ApexColor.textMuted)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, Spacing.xl)
            .frame(maxWidth: 420)
        }
        .accessibilityIdentifier("update.required")
    }
}
