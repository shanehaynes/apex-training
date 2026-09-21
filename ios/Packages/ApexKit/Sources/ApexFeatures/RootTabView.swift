import ApexUI
import SwiftUI

// The four tabs from D-012, each owning a NavigationStack so its routes push
// independently: Schedule/ScheduleTab.swift (W2), Coach/CoachTab.swift (W6),
// Analytics/AnalyticsTab.swift (W9), Profile/YouTab.swift (W11).
public struct RootTabView: View {
    private let schedule: ScheduleModel
    private let analytics: AnalyticsModel?
    private let tracker: TrackerServices?
    private let coach: CoachModel?
    private let coachServices: CoachServices?
    private let you: YouModel?
    private let meals: MealsModel?
    private let onboarding: OnboardingModel?
    private let email: String?
    private let onSignOut: () -> Void
    @Bindable private var routes: RouteBus

    /// `routes` is the deep-link bus (W12): a parked link selects its tab here
    /// and the tab consumes it. The default is a fresh bus, for previews.
    public init(
        schedule: ScheduleModel, analytics: AnalyticsModel? = nil, tracker: TrackerServices? = nil, coach: CoachModel? = nil,
        coachServices: CoachServices? = nil, you: YouModel? = nil, meals: MealsModel? = nil, onboarding: OnboardingModel? = nil,
        email: String?, routes: RouteBus = RouteBus(), onSignOut: @escaping () -> Void
    ) {
        self.schedule = schedule
        self.analytics = analytics
        self.you = you
        self.meals = meals
        self.onboarding = onboarding
        self.tracker = tracker
        self.coach = coach
        self.coachServices = coachServices
        self.email = email
        self.routes = routes
        self.onSignOut = onSignOut
    }

    public var body: some View {
        TabView(selection: $routes.tab) {
            ScheduleTab(model: schedule, tracker: tracker, routes: routes, coachServices: coachServices, meals: meals, onboarding: onboarding)
                .tabItem { Label("Schedule", systemImage: "calendar") }
                .tag(AppTab.schedule)
            CoachTab(model: coach)
                .tabItem { Label("Coach", systemImage: "sparkles") }
                .tag(AppTab.coach)
            Group {
                if let analytics {
                    AnalyticsTab(model: analytics, coachServices: coachServices)
                } else {
                    EmptyState(eyebrow: "Analytics", message: "Sign in to see your tiles.", symbol: "chart.line.uptrend.xyaxis")
                }
            }
            .tabItem { Label("Analytics", systemImage: "chart.line.uptrend.xyaxis") }
            .tag(AppTab.analytics)
            YouTab(model: you, routes: routes)
                .tabItem { Label("You", systemImage: "person") }
                .tag(AppTab.you)
        }
    }
}
