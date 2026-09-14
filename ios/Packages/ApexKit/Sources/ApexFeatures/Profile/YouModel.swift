import ApexCore
import ApexUI
import Foundation
import Observation

/// The You tab's state: the profile (read from `GET /api/profile`, D-028 —
/// never the table), the edits the sections make to it, and the three
/// integration models the root shows status for. Every write is a
/// `PATCH /api/profile` with exactly the keys that edit owns, followed by a
/// re-read, so what the screen shows is what the server stored (trimmed,
/// bounded, resolved).
@MainActor
@Observable
public final class YouModel {
    public let services: YouServices
    public let coros: CorosModel
    public let connector: ConnectorModel
    public let activity: ActivityLogModel

    public private(set) var profile: ProfileResponse?
    public private(set) var isLoading = false
    /// The first load failed and nothing is cached: the root shows a retry.
    public private(set) var loadError: String?
    public var showKeySheet = false
    private var isStarted = false

    public init(services: YouServices) {
        self.services = services
        self.coros = CorosModel(services: services)
        self.connector = ConnectorModel(services: services)
        self.activity = ActivityLogModel(services: services)
    }

    // Under the package's MainActor default isolation the deinit would be
    // isolated, and a model released while a hosting view tears down (the
    // snapshot tests) hops executors twice — YouModel's, then its sub-models' —
    // which the iOS 17 back-deployed runtime aborts on (a double free inside
    // swift_task_deinitOnExecutor). Nothing here needs the actor to die.
    nonisolated deinit {}

    public var email: String? { services.email }
    public var displayName: String { profile?.displayName?.nilIfBlank ?? email?.split(separator: "@").first.map(String.init) ?? "You" }
    public var avatarKey: String? { profile?.avatarKey }

    /// The model the coach will run on: the stored pick, or the server's
    /// resolved default (the label tells which entry that is).
    public var selectedModel: ProfileResponse.CoachModelOption? {
        guard let models = profile?.coachModels else { return nil }
        if let id = profile?.coachModel, let picked = models.first(where: { $0.id == id }) { return picked }
        return models.first { $0.label == profile?.coachModelLabel } ?? models.first
    }

    public var keyStatusLabel: String {
        guard let profile else { return "" }
        return profile.hasAnthropicKey ? "Saved · ••••\(profile.anthropicKeyLast4 ?? "")" : "Not set"
    }

    public var heartRateLabel: String {
        guard let profile else { return "" }
        switch (profile.thresholdHr, profile.maxHr) {
        case (nil, nil): return "Not set"
        case (let t?, nil): return "LTHR \(t)"
        case (nil, let m?): return "Max \(m)"
        case (let t?, let m?): return "\(t) · \(m) bpm"
        }
    }

    // MARK: - Lifecycle

    /// Idempotent — the tab's `.task` runs on every appearance.
    public func start() async {
        guard !isStarted else { return }
        isStarted = true
        await refreshProfile(initial: true)
        await coros.refreshStatus()
        await connector.load(quiet: true)
    }

    public func refreshProfile(initial: Bool = false) async {
        if initial { isLoading = true }
        defer { isLoading = false }
        do {
            profile = try await services.client.send(.profile, as: ProfileResponse.self)
            loadError = nil
        } catch {
            if profile == nil { loadError = Failure.message(error) }
        }
    }

    // MARK: - Edits

    /// One profile write: send, re-read, tell the coach. Returns the failure
    /// message, which the caller shows inline or toasts.
    @discardableResult
    private func patch(_ endpoint: Endpoint, success: String?) async -> String? {
        do {
            _ = try await services.client.send(endpoint, as: ProfileUpdateResponse.self)
        } catch {
            let message = Failure.message(error)
            ToastBus.shared.post(message, level: .failure)
            return message
        }
        await refreshProfile()
        services.onProfileChanged()
        if let success { ToastBus.shared.post(success, level: .success) }
        return nil
    }

    /// Blank or unchanged is a no-op, as on the web (`saveName`).
    public func saveDisplayName(_ raw: String) async -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != profile?.displayName else { return nil }
        guard trimmed.count <= 80 else { return "Names are at most 80 characters." }
        return await patch(.setDisplayName(trimmed), success: "Name updated")
    }

    public func saveAvatar(_ key: String) async {
        guard key != profile?.avatarKey else { return }
        await patch(.setAvatarKey(key), success: nil)
    }

    /// Both zones in one write. Blank clears; anything else must be a whole
    /// number in the handler's bounds (max 100–250, threshold 80–230) — the
    /// API 400s out-of-range values, so the check runs here first, with the
    /// web's wording.
    public func saveHeartRate(maxHr rawMax: String, thresholdHr rawThreshold: String) async -> String? {
        guard let max = Self.parseZone(rawMax, bounds: 100...250) else {
            return "Max HR must be a whole number between 100 and 250"
        }
        guard let threshold = Self.parseZone(rawThreshold, bounds: 80...230) else {
            return "Threshold HR must be a whole number between 80 and 230"
        }
        guard max.value != profile?.maxHr || threshold.value != profile?.thresholdHr else { return nil }
        return await patch(.setHeartRateZones(maxHr: max.value, thresholdHr: threshold.value), success: "Heart-rate zones updated")
    }

    /// nil = invalid; `.init(value: nil)` = cleared.
    public static func parseZone(_ raw: String, bounds: ClosedRange<Int>) -> Zone? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return Zone(value: nil) }
        guard let value = Int(trimmed), bounds.contains(value) else { return nil }
        return Zone(value: value)
    }

    public struct Zone: Equatable, Sendable {
        public let value: Int?
        public init(value: Int?) { self.value = value }
    }

    /// Unlike the name, empty is a valid save — clearing a coach field is an edit.
    public func saveCoachProfile(goal rawGoal: String, context rawContext: String) async -> String? {
        let goal = rawGoal.trimmingCharacters(in: .whitespacesAndNewlines)
        let context = rawContext.trimmingCharacters(in: .whitespacesAndNewlines)
        guard goal != (profile?.coachGoal ?? "") || context != (profile?.coachContext ?? "") else { return nil }
        guard goal.count <= 200 else { return "The goal is at most 200 characters." }
        guard context.count <= 1000 else { return "The context is at most 1000 characters." }
        return await patch(.setCoachProfile(goal: goal, context: context), success: "Coach updated")
    }

    public func saveCoachModel(_ id: String) async {
        guard id != selectedModel?.id else { return }
        await patch(.setCoachModel(id), success: nil)
    }

    /// The key sheet talked to `/api/profile` itself; re-read and tell the coach.
    public func keyChanged() async {
        await refreshProfile()
        services.onProfileChanged()
    }

    // MARK: - Account

    /// The web's rules (`ProfileView.changePassword`): eight characters, both fields equal.
    public func changePassword(_ password: String, confirm: String) async -> String? {
        guard password.count >= 8 else { return "Password must be at least 8 characters." }
        guard password == confirm else { return "Passwords do not match." }
        if let error = await services.changePassword(password) { return error }
        ToastBus.shared.post("Password updated.", level: .success)
        return nil
    }

    /// Irreversible. The typed confirmation is the view's; the server has its
    /// own (`confirm: "DELETE"` in the body). On success the session is gone
    /// with the user, so the app signs out.
    public func deleteAccount() async -> String? {
        do {
            _ = try await services.client.send(.deleteAccount, as: AccountDeleteResponse.self)
        } catch {
            return "Deletion failed. Nothing was removed — try again, or get in touch."
        }
        services.onAccountDeleted()
        return nil
    }

    public func signOut() {
        services.signOut()
    }
}

extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
