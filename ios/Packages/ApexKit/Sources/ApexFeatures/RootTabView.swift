import ApexUI
import SwiftUI

public struct RootTabView: View {
    private let email: String?
    private let onSignOut: () -> Void

    public init(email: String?, onSignOut: @escaping () -> Void) {
        self.email = email
        self.onSignOut = onSignOut
    }

    public var body: some View {
        TabView {
            ScheduleTab()
                .tabItem { Label("Schedule", systemImage: "calendar") }
            CoachTab()
                .tabItem { Label("Coach", systemImage: "sparkles") }
            AnalyticsTab()
                .tabItem { Label("Analytics", systemImage: "chart.line.uptrend.xyaxis") }
            YouTab(email: email, onSignOut: onSignOut)
                .tabItem { Label("You", systemImage: "person") }
        }
        .tint(ApexColor.accent)
    }
}
