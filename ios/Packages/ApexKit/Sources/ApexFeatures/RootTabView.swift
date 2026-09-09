import ApexUI
import SwiftUI

public struct RootTabView: View {
    private let schedule: ScheduleModel
    private let tracker: TrackerServices?
    private let coach: CoachModel?
    private let email: String?
    private let onSignOut: () -> Void
    @Bindable private var routes: RouteBus

    /// `routes` is the deep-link bus (W12): a parked link selects its tab here
    /// and the tab consumes it. The default is a fresh bus, for previews.
    public init(
        schedule: ScheduleModel, tracker: TrackerServices? = nil, coach: CoachModel? = nil,
        email: String?, routes: RouteBus = RouteBus(), onSignOut: @escaping () -> Void
    ) {
        self.schedule = schedule
        self.tracker = tracker
        self.coach = coach
        self.email = email
        self.routes = routes
        self.onSignOut = onSignOut
    }

    public var body: some View {
        TabView(selection: $routes.tab) {
            ScheduleTab(model: schedule, tracker: tracker, routes: routes)
                .tabItem { Label("Schedule", systemImage: "calendar") }
                .tag(AppTab.schedule)
            CoachTab(model: coach)
                .tabItem { Label("Coach", systemImage: "sparkles") }
                .tag(AppTab.coach)
            AnalyticsTab()
                .tabItem { Label("Analytics", systemImage: "chart.line.uptrend.xyaxis") }
                .tag(AppTab.analytics)
            YouTab(email: email, onSignOut: onSignOut)
                .tabItem { Label("You", systemImage: "person") }
                .tag(AppTab.you)
        }
        .tint(ApexColor.accent)
    }
}
