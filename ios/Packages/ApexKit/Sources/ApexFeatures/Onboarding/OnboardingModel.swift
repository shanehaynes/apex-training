import ApexCore
import ApexUI
import Foundation
import Observation

/// First-run state (W13, U32): whether the welcome flow is due, which setup
/// rows the Schedule card shows, and what each button does. The copy is the
/// generated `OnboardingCatalog`; the verdicts are the server's
/// (`ProfileResponse.onboarding`, D-035) — this model decides nothing about
/// progress, it only reads it back after every write that could change it.
@MainActor
@Observable
public final class OnboardingModel {
    public struct Dependencies {
        public let client: ApexClient
        public let routes: RouteBus
        /// Whether the deployment has a watch provider; the COROS step and row
        /// are dropped without one (the web's `corosConfigured`). Async because
        /// the answer is the provider status, which the You tab loads lazily.
        public let corosConfigured: @MainActor () async -> Bool
        /// The starter plan landed: the schedule re-reads its window.
        public let onTemplateCopied: @MainActor () async -> Void
        /// Presents the Anthropic key sheet on the You tab.
        public let openKeySheet: @MainActor () -> Void
        /// The web app's origin (`AppConfig.publicOrigin`): the catalog's links
        /// are Apex-hosted and relative (`/help/get-api-key`), and a phone has
        /// no page to resolve them against. Nil hides a relative link rather
        /// than opening a URL with no host.
        public let publicOrigin: URL?

        public init(
            client: ApexClient, routes: RouteBus, corosConfigured: @escaping @MainActor () async -> Bool,
            onTemplateCopied: @escaping @MainActor () async -> Void, openKeySheet: @escaping @MainActor () -> Void,
            publicOrigin: URL? = nil
        ) {
            self.client = client
            self.routes = routes
            self.corosConfigured = corosConfigured
            self.onTemplateCopied = onTemplateCopied
            self.openKeySheet = openKeySheet
            self.publicOrigin = publicOrigin
        }
    }

    public struct NudgeRow: Identifiable, Hashable, Sendable {
        public let item: OnboardingCatalog.ChecklistItem
        public let done: Bool
        public var id: OnboardingCatalog.ChecklistID { item.id }
    }

    private let deps: Dependencies
    public private(set) var state: ProfileResponse.OnboardingState?
    /// Resolved once at `start()`; previews get `true`.
    public private(set) var corosConfigured = false
    public private(set) var isCopying = false
    /// Finishing or skipping latches locally at once; the PATCH follows. A
    /// failed PATCH means the flow comes back on the next launch, which is the
    /// web's behaviour too.
    private var dismissedLocally = false
    /// The card's close is session-only (the web's `hidden`): the full list
    /// lives on the You tab, so nothing is lost and no flag is spent.
    public var nudgeHidden = false
    /// The welcome flow's page — a page, not a step: several steps share one
    /// (`welcomePages`).
    public var pageIndex = 0

    public init(deps: Dependencies) {
        self.deps = deps
    }

    /// Previews and snapshots: a model already holding a state.
    public init(deps: Dependencies, state: ProfileResponse.OnboardingState?) {
        self.deps = deps
        self.state = state
        self.corosConfigured = true
    }

    // Under MainActor default isolation the deinit would be synthesized as
    // *isolated*, which routes deallocation through swift_task_deinitOnExecutor
    // and aborts on the iOS 17/18 runtime when the object dies outside a task
    // (swiftlang/swift#87316, D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

    // MARK: - Reads

    public func start() async {
        corosConfigured = await deps.corosConfigured()
        await refresh()
    }

    /// Re-reads the profile. Called after every write that could tick a row:
    /// the key sheet, the coach profile, the template copy.
    public func refresh() async {
        guard let data = try? await deps.client.data(for: .profile),
              let profile = try? JSONDecoder().decode(ProfileResponse.self, from: data) else { return }
        state = profile.onboarding
    }

    // MARK: - What shows

    /// The welcome flow is due: a real user (not the template source) who has
    /// never finished or skipped it.
    public var showsWelcome: Bool {
        guard let state, state.applies, !dismissedLocally else { return false }
        return state.dismissedAt == nil
    }

    /// The card: same user, flow already dismissed, something left to do.
    public var showsNudge: Bool {
        guard let state, state.applies, !nudgeHidden else { return false }
        return (state.dismissedAt != nil || dismissedLocally) && !state.setup.allDone
    }

    public var welcomeSteps: [OnboardingCatalog.Step] {
        OnboardingCatalog.welcomeSteps.filter { !$0.requiresCoros || corosConfigured }
    }

    /// One page of the welcome flow: the steps it carries, in catalog order.
    public struct WelcomePage: Identifiable, Sendable, Hashable {
        /// The first step on the page — stable across a `requiresCoros` filter,
        /// which an index is not.
        public var id: String { steps[0].id }
        public let steps: [OnboardingCatalog.Step]
    }

    /// One step per page. The eight-step tour was grouped onto four pages
    /// (ux-review §3.9); the catalog is four steps now (D-O05), so the grouping
    /// has nothing left to merge and the app matches the web page for page.
    ///
    /// A table over step *ids*, not indices or counts: a step the catalog adds
    /// gets a page of its own rather than disappearing, and
    /// `OnboardingModelTests` fails if the table and the catalog disagree.
    static let welcomePageGroups: [[String]] = [
        ["welcome"],
        ["plan"],
        ["log"],
        ["coach"],
    ]

    public var welcomePages: [WelcomePage] {
        let steps = welcomeSteps
        let byID = Dictionary(steps.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var pages = Self.welcomePageGroups.compactMap { ids -> WelcomePage? in
            let group = ids.compactMap { byID[$0] }
            return group.isEmpty ? nil : WelcomePage(steps: group)
        }
        let grouped = Set(Self.welcomePageGroups.joined())
        pages.append(contentsOf: steps.filter { !grouped.contains($0.id) }.map { WelcomePage(steps: [$0]) })
        return pages
    }

    /// The coach page carries the goal row as well as the key: a key with no
    /// goal is half a coach. It is the checklist's row (`ChecklistID.goal`),
    /// not a fifth step — nothing about the web's tour changes.
    public func extraRow(for page: WelcomePage) -> OnboardingCatalog.ChecklistItem? {
        page.steps.contains { $0.id == "coach" } ? OnboardingCatalog.checklistItem(.goal) : nil
    }

    /// Where a step's link goes. An absolute href opens as written; a relative
    /// one (every catalog link today, D-O05) resolves against the web origin,
    /// and without one there is nowhere to send it, so the link is hidden.
    public func destination(for link: OnboardingCatalog.Link) -> URL? {
        if let absolute = URL(string: link.href), absolute.scheme != nil { return absolute }
        guard let origin = deps.publicOrigin else { return nil }
        return URL(string: link.href, relativeTo: origin)?.absoluteURL
    }

    public var nudgeRows: [NudgeRow] {
        guard let setup = state?.setup else { return [] }
        return OnboardingCatalog.nudgeIDs.compactMap { id in
            guard let item = OnboardingCatalog.checklistItem(id), let done = setup.isDone(id) else { return nil }
            return NudgeRow(item: item, done: done)
        }
    }

    public var nudgeDoneCount: Int { nudgeRows.filter(\.done).count }

    // MARK: - Writes

    /// Finish or skip: latch locally, then on the server so no other device
    /// shows the flow again.
    public func dismissWelcome() async {
        dismissedLocally = true
        _ = try? await deps.client.data(for: .dismissOnboarding)
        await refresh()
    }

    /// The step's or row's button. Anything that leaves for the You tab also
    /// dismisses the flow — it is one-shot, and the card stays for the rest.
    public func run(_ action: OnboardingCatalog.Action, for id: String) async {
        switch action.kind {
        case .copyTemplate:
            await copyTemplate()
        case .openProfile:
            if showsWelcome { await dismissWelcome() }
            deps.routes.tab = .you
            switch id {
            case "coach", OnboardingCatalog.ChecklistID.key.rawValue:
                deps.openKeySheet()
            case OnboardingCatalog.ChecklistID.connector.rawValue:
                deps.routes.pendingYou = .connector
            case OnboardingCatalog.ChecklistID.goal.rawValue:
                deps.routes.pendingYou = .coachProfile
            default:
                break
            }
        case .connectCoros:
            if showsWelcome { await dismissWelcome() }
            deps.routes.tab = .you
            deps.routes.pendingYou = .coros
        }
    }

    /// `POST /api/template-copy`; the toast is the web's (`useTemplateCopy`).
    public func copyTemplate() async {
        guard !isCopying else { return }
        isCopying = true
        defer { isCopying = false }
        do {
            let data = try await deps.client.data(for: .copyTemplate)
            let result = (try? JSONDecoder().decode(TemplateCopyResult.self, from: data)) ?? TemplateCopyResult()
            ToastBus.shared.post(
                result.alreadyCopied == true ? "Already copied" : "Added \(result.events ?? 0) recurring workouts",
                level: .success
            )
            await deps.onTemplateCopied()
            await refresh()
        } catch {
            ToastBus.shared.post((error as? APIError)?.description ?? "Could not copy the starter plan.", level: .failure)
        }
    }

    private struct TemplateCopyResult: Decodable {
        var events: Int?
        var alreadyCopied: Bool?
    }
}
