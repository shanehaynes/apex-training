import ApexCore
import ApexUI
import SwiftUI

/// The Schedule tab: Day (default) ⇄ Month under one period bar, sheets for a
/// day and an event, the freshness line when the cache has to speak for itself.
public struct ScheduleTab: View {
    @Bindable private var model: ScheduleModel
    private let tracker: TrackerServices?
    private let routes: RouteBus?
    @State private var sheet: ScheduleSheet?
    @State private var trackerRoute: TrackerRoute?
    /// Set while the event sheet is still dismissing: presenting the cover over
    /// a sheet mid-dismiss is what produces "attempt to present while a
    /// presentation is in progress".
    @State private var pendingTracker: TrackerRoute?

    /// `tracker: nil` hides Start Workout (the app before a user is signed in).
    /// `routes` is the deep-link bus this tab consumes `.tracker` from (W12).
    public init(model: ScheduleModel, tracker: TrackerServices? = nil, routes: RouteBus? = nil) {
        self.model = model
        self.tracker = tracker
        self.routes = routes
    }

    private var trackerDependencies: TrackerDependencies? {
        guard let tracker else { return nil }
        let model = self.model
        return TrackerDependencies(
            services: tracker,
            definitions: { await model.definitions() },
            onCompletionChanged: { event, isCompleted, completedAt in
                model.applyCompletionLocally(id: event.id, isCompleted: isCompleted, completedAt: completedAt)
            }
        )
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                PeriodBar(model: model)
                if let label = model.freshnessLabel {
                    FreshnessBanner(label)
                }
                content
            }
            .background(ApexColor.bgPrimary)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Wordmark() }
            }
            .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .sheet(item: $sheet, onDismiss: presentPendingTracker) { item in
            Group {
                switch item {
                case .event(let id):
                    EventSheet(
                        model: model, eventId: id,
                        onStart: tracker == nil ? nil : { event in
                            pendingTracker = TrackerRoute(event: event)
                            sheet = nil
                        },
                        onClose: { sheet = nil }
                    )
                case .day(let day):
                    DaySheet(model: model, day: day, onOpenEvent: { sheet = .event(id: $0.id) }, onClose: { sheet = nil })
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        .fullScreenCover(item: $trackerRoute) { route in
            if let deps = trackerDependencies {
                TrackerHost(route: route, deps: deps)
            }
        }
        .task { await model.start() }
        // The Live Activity's tap. Two triggers: the link arriving while the
        // index is loaded, and the index arriving after a cold-launch link.
        .onChange(of: routes?.pending, initial: true) { _, _ in consumeRoute() }
        .onChange(of: model.index == nil) { _, _ in consumeRoute() }
    }

    private func presentPendingTracker() {
        guard let route = pendingTracker else { return }
        pendingTracker = nil
        trackerRoute = route
    }

    /// `.tracker(id:date:)` → the occurrence, presented the same way Start
    /// Workout presents it. Waits for the index; a miss (the occurrence is
    /// outside the window around today) is a toast, and the link is spent.
    private func consumeRoute() {
        guard let routes, tracker != nil, model.index != nil,
              let link = routes.take(where: { if case .tracker = $0 { true } else { false } }) else { return }
        guard let route = TrackerRouteResolver.route(for: link, in: model.index) else {
            ToastBus.shared.post("That workout is not on the schedule any more.", level: .failure)
            return
        }
        // Already showing it (the app was in the tracker when the island was tapped).
        if trackerRoute?.id == route.id { return }
        // Another session's tracker is up: leave it — the user is in a workout.
        if trackerRoute != nil { return }
        if sheet != nil {
            pendingTracker = route
            sheet = nil
        } else {
            trackerRoute = route
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.index == nil, let error = model.loadError {
            VStack(spacing: Spacing.md) {
                EmptyState(eyebrow: "Schedule", message: error, symbol: ApexIcon.offline.systemName)
                    .frame(maxHeight: 220)
                ApexButton("Retry", kind: .secondary, isLoading: model.isRefreshing) {
                    Task { await model.refresh(reason: .retry) }
                }
                .frame(maxWidth: 200)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ApexColor.bgPrimary)
        } else if model.index == nil {
            ZStack {
                ApexColor.bgPrimary.ignoresSafeArea()
                ProgressView().tint(ApexColor.textMuted)
            }
        } else {
            switch model.mode {
            case .day:
                DayView(model: model, onOpen: { sheet = .event(id: $0.id) })
            case .month:
                MonthView(model: model, onOpenDay: { sheet = .day($0) }, onOpenEvent: { sheet = .event(id: $0.id) })
            }
        }
    }
}

/// `‹ title ›` · Today · Day|Month — the web's TopNav, minus the "+" that
/// arrives with the builder (W7).
struct PeriodBar: View {
    @Bindable var model: ScheduleModel

    var body: some View {
        VStack(spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                stepButton(ApexIcon.chevronLeft, label: "Previous", delta: -1)
                Text(model.periodTitle)
                    .font(.apex(.display, size: TypeScale.base, weight: .semibold, relativeTo: .headline))
                    .foregroundStyle(ApexColor.textPrimary)
                    .frame(maxWidth: .infinity)
                    .contentTransition(.numericText())
                    .accessibilityIdentifier("schedule.period")
                stepButton(ApexIcon.chevronRight, label: "Next", delta: 1)
                Button("Today") { withAnimation(Motion.spring) { model.goToToday() } }
                    .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                    .foregroundStyle(model.isShowingToday ? ApexColor.textMuted : ApexColor.textPrimary)
                    .padding(.horizontal, Spacing.md)
                    .frame(minHeight: 32)
                    .background(ApexColor.bgSurface, in: .capsule)
                    .overlay(Capsule().strokeBorder(ApexColor.borderSubtle, lineWidth: 1))
                    .disabled(model.isShowingToday)
                    .frame(minHeight: 44)
            }
            ApexSegmented(selection: $model.mode, options: [(.day, "Day"), (.month, "Month")])
                .frame(maxWidth: 220)
        }
        .padding(.horizontal, Spacing.screen)
        .padding(.top, Spacing.sm)
        .padding(.bottom, Spacing.md)
        .background(ApexColor.bgPrimary)
    }

    private func stepButton(_ icon: ApexIcon, label: String, delta: Int) -> some View {
        Button { withAnimation(Motion.spring) { model.step(delta) } } label: {
            icon.image
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ApexColor.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
