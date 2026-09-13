import ApexUI
import SwiftUI

// The four tabs from D-012. Each owns a NavigationStack so its own routes push
// independently. Schedule lives in Schedule/ScheduleTab.swift (W2), Coach in
// Coach/CoachTab.swift (W6), You in Profile/YouTab.swift (W11); Analytics arrives in W9.

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
