import ApexCore
import ApexUI
import SwiftUI

/// The Schedule tab: Day (default) ⇄ Month under one period bar, sheets for a
/// day and an event, the freshness line when the cache has to speak for itself.
public struct ScheduleTab: View {
    @Bindable private var model: ScheduleModel
    private let tracker: TrackerServices?
    private let routes: RouteBus?
    /// The builder's coach drawer (W7); nil hides the drawer.
    private let coachServices: CoachServices?
    /// The meal composer (W10); nil keeps "+" a plain Add workout.
    private let meals: MealsModel?
    /// The setup card (W13, U32); nil shows none.
    private let onboarding: OnboardingModel?
    /// The running workout (ux-review §3.4). Comes off `tracker` in the app;
    /// the parameter is how a snapshot reaches the state without a queue.
    private let live: LiveSessionStore?
    @State private var sheet: ScheduleSheet?
    @State private var trackerRoute: TrackerRoute?
    /// Set while the event sheet is still dismissing: presenting the cover over
    /// a sheet mid-dismiss is what produces "attempt to present while a
    /// presentation is in progress".
    @State private var pendingTracker: TrackerRoute?
    /// Same rule for a sheet that replaces the event sheet (the builder, the
    /// exercises editor — the web's OPEN_EVENT_EDITOR replaces the modal).
    @State private var pendingSheet: ScheduleSheet?

    /// `tracker: nil` hides Start Workout (the app before a user is signed in).
    /// `routes` is the deep-link bus this tab consumes `.tracker` from (W12).
    public init(
        model: ScheduleModel, tracker: TrackerServices? = nil, routes: RouteBus? = nil, coachServices: CoachServices? = nil,
        meals: MealsModel? = nil, onboarding: OnboardingModel? = nil, live: LiveSessionStore? = nil
    ) {
        self.model = model
        self.tracker = tracker
        self.routes = routes
        self.coachServices = coachServices
        self.meals = meals
        self.onboarding = onboarding
        self.live = live ?? tracker?.live
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
                if let label = model.freshnessLabel {
                    FreshnessBanner(label)
                }
                content
            }
            .background(ApexColor.bgPrimary)
            // The date is the title (ux-review §3.2): it was stated four times
            // over — period bar, week strip, a 42pt numeral and a TODAY pill —
            // before the first card.
            //
            // Inline rather than a large title that collapses on scroll. A
            // large title is tracked against one scroll view, and Day ⇄ Month
            // replaces it: the bar stays collapsed and the date disappears
            // altogether for the rest of the session. Inline is always drawn,
            // and it gives back the ~60pt the title row was holding.
            .navigationTitle(dateTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // An inline title is centred, so iOS gives it only what the
                // *wider* of the two groups leaves twice over. Four controls
                // is the most this bar holds with the date still legible, so
                // Today — the one that is pressed rarely — rides in the menu.
                ToolbarItemGroup(placement: .topBarLeading) {
                    stepButton(ApexIcon.chevronLeft, label: "Previous", delta: -1)
                    stepButton(ApexIcon.chevronRight, label: "Next", delta: 1)
                }
                ToolbarItem(placement: .topBarTrailing) { periodMenu }
                ToolbarItem(placement: .topBarTrailing) {
                    // With a composer wired, "+" offers a workout or a meal (the
                    // web's FAB, W10); without one it stays the builder's door.
                    if meals != nil {
                        Menu {
                            Button { sheet = .builder(.create(date: model.selectedDay)) } label: {
                                Label("Add workout", systemImage: ApexIcon.dumbbell.systemName)
                            }
                            .accessibilityIdentifier("schedule.add.workout")
                            Button { sheet = .mealComposer(.create(model.selectedDay)) } label: {
                                Label("Add meal", systemImage: ApexIcon.utensils.systemName)
                            }
                            .accessibilityIdentifier("schedule.add.meal")
                        } label: {
                            ApexIcon.plus.image
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(ApexColor.textPrimary)
                                .frame(width: 44, height: 44)
                                .contentShape(.rect)
                        }
                        .accessibilityLabel("Add")
                        .accessibilityIdentifier("schedule.add")
                    } else {
                        Button {
                            sheet = .builder(.create(date: model.selectedDay))
                        } label: {
                            ApexIcon.plus.image
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(ApexColor.textPrimary)
                                .frame(width: 44, height: 44)
                                .contentShape(.rect)
                        }
                        .accessibilityLabel("Add workout")
                        .accessibilityIdentifier("schedule.add")
                    }
                }
            }
            .toolbarBackground(ApexColor.bgPrimary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .sheet(item: $sheet, onDismiss: { meals?.flushNotice(); presentPending() }) { item in
            Group {
                switch item {
                case .event(let id):
                    EventSheet(
                        model: model, eventId: id,
                        onStart: tracker == nil ? nil : { event in
                            pendingTracker = TrackerRoute(event: event)
                            sheet = nil
                        },
                        onEditWorkout: { event in
                            pendingSheet = .builder(.edit(eventId: event.id))
                            sheet = nil
                        },
                        onEditExercises: { event in
                            pendingSheet = .editExercises(id: event.id)
                            sheet = nil
                        },
                        onClose: { sheet = nil }
                    )
                    .presentationDetents([.medium, .large])
                case .day(let day):
                    DaySheet(
                        model: model, day: day, onOpenEvent: { sheet = .event(id: $0.id) }, onClose: { sheet = nil },
                        onAddMeal: meals == nil ? nil : { day in
                            pendingSheet = .mealComposer(.create(day))
                            sheet = nil
                        },
                        onOpenMeal: meals == nil ? nil : { item in
                            pendingSheet = .mealComposer(.edit(day: day, item: item))
                            sheet = nil
                        }
                    )
                    .presentationDetents([.medium, .large])
                case .builder(let route):
                    BuilderSheet(model: model, route: route, coachServices: coachServices, onClose: { sheet = nil })
                        .presentationDetents([.large])
                case .editExercises(let id):
                    if let event = model.event(id: id) {
                        EditExercisesSheet(model: model, event: event, onClose: { sheet = nil })
                            .presentationDetents([.large])
                    }
                case .mealComposer(let route):
                    if let meals {
                        MealComposerSheet(model: meals, route: route, onClose: { sheet = nil })
                            .presentationDetents([.large])
                    }
                }
            }
            .presentationDragIndicator(.visible)
            .presentationBackground(ApexColor.bgSurface)
        }
        // design-spec §9: workout completed, from the sheet or a day card.
        .sensoryFeedback(.success, trigger: model.completedCount)
        .fullScreenCover(item: $trackerRoute) { route in
            if let deps = trackerDependencies {
                TrackerHost(route: route, deps: deps)
            }
        }
        .task { await model.start() }
        // The Live Activity's tap. Two triggers: the link arriving while the
        // index is loaded, and the index arriving after a cold-launch link.
        .onChange(of: routes?.pending, initial: true) { _, _ in consumeRoute(); consumeEventRoute() }
        .onChange(of: model.index == nil) { _, _ in consumeRoute(); consumeEventRoute() }
    }

    /// `/app/event/<id>/<date>` (W7): the event sheet, once the index can
    /// find it; a miss is a toast and the link is spent (D-026).
    private func consumeEventRoute() {
        guard let routes, model.index != nil,
              let link = routes.take(where: { if case .event = $0 { true } else { false } }) else { return }
        guard let route = EventRouteResolver.route(for: link, in: model.index) else {
            ToastBus.shared.post("That workout is not on the schedule any more.", level: .failure)
            return
        }
        if sheet != nil {
            pendingSheet = route
            sheet = nil
        } else {
            sheet = route
        }
    }

    private func presentPending() {
        if let route = pendingTracker {
            pendingTracker = nil
            trackerRoute = route
        } else if let next = pendingSheet {
            pendingSheet = nil
            sheet = next
        }
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
        openTracker(route)
    }

    /// The one door to the cover, whoever knocks: the Live Activity's link, an
    /// event sheet's Start, a running day card. A sheet still on screen has to
    /// finish dismissing first — presenting the cover over it is what produces
    /// "attempt to present while a presentation is in progress".
    private func openTracker(_ route: TrackerRoute) {
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

    /// The date, stated once. `periodTitle` spells the year out on every
    /// month, and "September 2026" is wider than an inline title gets next to
    /// four controls — so the year is dropped when it is this one, which is
    /// what the system Calendar does and what the user already knows.
    private var dateTitle: String {
        switch model.mode {
        case .day:
            return model.periodTitle
        case .month:
            let name = MonthNames.long[model.selectedDay.month - 1]
            guard model.selectedDay.year != model.today.year else { return name }
            return "\(name) \(String(model.selectedDay.year))"
        }
    }

    /// Day ⇄ Month. A two-option segmented control was a full-width row of its
    /// own for a switch that is thrown rarely (ux-review §1.3); a menu in the
    /// bar costs one tap and no vertical space. Icon-only because the word
    /// would cost the title its room — which of the two is showing is the one
    /// thing the screen below cannot be mistaken about. Keeps `schedule.period`.
    private var periodMenu: some View {
        Menu {
            Picker("View", selection: $model.mode) {
                Text("Day").tag(ScheduleMode.day)
                Text("Month").tag(ScheduleMode.month)
            }
            .pickerStyle(.inline)
            Divider()
            Button("Today") { Motion.animate { model.goToToday() } }
                .disabled(model.isShowingToday)
                .accessibilityIdentifier("schedule.today")
        } label: {
            ApexIcon.calendar.image
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(ApexColor.textPrimary)
                .frame(width: 32, height: 44)
                .contentShape(.rect)
        }
        .accessibilityLabel("View")
        .accessibilityValue(model.mode == .day ? "Day" : "Month")
        .accessibilityIdentifier("schedule.period")
    }

    private func stepButton(_ icon: ApexIcon, label: String, delta: Int) -> some View {
        Button { Motion.animate { model.step(delta) } } label: {
            icon.image
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ApexColor.textSecondary)
                .frame(width: 32, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
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
                DayView(
                    model: model, onOpen: { sheet = .event(id: $0.id) }, onAdd: { sheet = .builder(.create(date: $0)) },
                    onAddMeal: meals == nil ? nil : { sheet = .mealComposer(.create($0)) }, onboarding: onboarding,
                    live: live, onResume: tracker == nil ? nil : { openTracker(TrackerRoute(event: $0)) }
                )
            case .month:
                MonthView(
                    model: model, onOpenDay: { sheet = .day($0) }, onAdd: { sheet = .builder(.create(date: $0)) }
                )
            }
        }
    }
}

// MARK: - Preview factories (snapshots reach the internal sheets through these)

extension ScheduleTab {
    /// "Edit exercises" for an event, as the tab presents it.
    public static func editExercisesPreview(model: ScheduleModel, eventId: String) -> AnyView {
        guard let event = model.event(id: eventId) else { return AnyView(EmptyView()) }
        return AnyView(EditExercisesSheet(model: model, event: event, onClose: {}))
    }

    /// The exercise picker in a given state.
    public static func pickerPreview(definitions: [ExerciseDefinition], query: String, creating: Bool) -> AnyView {
        AnyView(ExercisePickerSheet(
            definitions: definitions, preferredCategory: "strength", initialQuery: query, initialCreating: creating,
            onPick: { _ in }, onCreate: { _, _, _ in nil }, onClose: {}
        ))
    }
}
