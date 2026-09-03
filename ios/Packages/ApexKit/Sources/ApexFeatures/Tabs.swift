import ApexUI
import SwiftUI

// The four tabs from D-012. Each owns a NavigationStack so its own routes push
// independently; the screens themselves arrive in W2/W6/W9/W11.

public struct ScheduleTab: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyState(
                eyebrow: "Schedule",
                message: "Your training calendar lands here in W2.",
                symbol: "calendar"
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Wordmark() }
            }
        }
    }
}

public struct CoachTab: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyState(
                eyebrow: "Coach",
                message: "The coach thread lands here in W6.",
                symbol: "sparkles"
            )
            .navigationTitle("Coach")
        }
    }
}

public struct AnalyticsTab: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyState(
                eyebrow: "Analytics",
                message: "Your tiles land here in W9.",
                symbol: "chart.line.uptrend.xyaxis"
            )
            .navigationTitle("Analytics")
        }
    }
}

public struct YouTab: View {
    private let email: String?
    private let onSignOut: () -> Void

    public init(email: String?, onSignOut: @escaping () -> Void) {
        self.email = email
        self.onSignOut = onSignOut
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    if let email {
                        VStack(alignment: .leading, spacing: Spacing.xs) {
                            Text("Signed in as").apexFieldLabel()
                            Text(email)
                                .font(.apex(.display, size: TypeScale.base, weight: .medium))
                                .foregroundStyle(ApexColor.textPrimary)
                        }
                    }

                    Text("Library, blocks, meals and settings land here in W10 and W11.")
                        .apexBody()

                    ApexButton("Sign out", kind: .secondary, action: onSignOut)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.screen)
            }
            .background(ApexColor.bgPrimary)
            .navigationTitle("You")
        }
    }
}
