import ApexCore
import ApexUI
import Foundation
import Observation

/// The AI connector (`McpTokens.tsx`): the personal access tokens that
/// authenticate the remote MCP endpoint, and the OAuth clients that signed in.
/// The plaintext token exists in exactly one response — the mint — so it is
/// held here only until the reveal sheet is dismissed.
@MainActor
@Observable
public final class ConnectorModel {
    private let services: YouServices

    public private(set) var tokens: [McpToken] = []
    public private(set) var connections: [McpConnection] = []
    public private(set) var isLoaded = false
    public private(set) var isMinting = false
    public var name = ""
    /// Drives the one-time reveal sheet; cleared when it closes.
    public var minted: MintedMcpToken?

    public init(services: YouServices) {
        self.services = services
    }

    // Under the package's MainActor default isolation the deinit would be
    // isolated, and a model released while a hosting view tears down (the
    // snapshot tests) hops executors twice — YouModel's, then its sub-models' —
    // which the iOS 17 back-deployed runtime aborts on (a double free inside
    // swift_task_deinitOnExecutor). Nothing here needs the actor to die.
    nonisolated deinit {}

    public var endpoint: String { services.mcpEndpoint.absoluteString }
    public var activeTokens: [McpToken] { tokens.filter(\.isActive) }
    public var canMint: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !isMinting }

    /// "2 tokens" · "Not set up" — the root row's value.
    public var statusLabel: String {
        guard isLoaded else { return "" }
        let count = activeTokens.count
        return count > 0 ? "\(count) token\(count == 1 ? "" : "s")" : "Not set up"
    }

    /// `quiet` is the root's status read: a failure there leaves the row's
    /// value blank rather than toasting over a screen that did not ask.
    public func load(quiet: Bool = false) async {
        do {
            let response = try await services.client.send(.mcpTokens, as: McpTokensResponse.self)
            tokens = response.tokens
            connections = response.connections
            isLoaded = true
        } catch {
            if !quiet { ToastBus.shared.post(Failure.message(error), level: .failure) }
        }
    }

    public func mint() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !isMinting else { return }
        isMinting = true
        defer { isMinting = false }
        do {
            let fresh = try await services.client.send(.mintMcpToken(name: String(trimmed.prefix(60))), as: MintedMcpToken.self)
            name = ""
            minted = fresh
            await load()
        } catch {
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    /// The row stays, marked revoked, as the web keeps it — nothing is deleted.
    public func revoke(_ token: McpToken) async {
        do {
            _ = try await services.client.send(.revokeMcpToken(id: token.id), as: McpRevokeResponse.self)
            tokens = tokens.map {
                $0.id == token.id
                    ? McpToken(id: $0.id, name: $0.name, tokenLast4: $0.tokenLast4, createdAt: $0.createdAt, lastUsedAt: $0.lastUsedAt,
                               revokedAt: CompletionRows.isoTimestamp(services.clock.now))
                    : $0
            }
            ToastBus.shared.post("Token revoked")
        } catch {
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    public func disconnect(_ connection: McpConnection) async {
        do {
            _ = try await services.client.send(.disconnectApp(clientId: connection.clientId), as: McpRevokeResponse.self)
            connections.removeAll { $0.clientId == connection.clientId }
            ToastBus.shared.post("Disconnected")
        } catch {
            ToastBus.shared.post(Failure.message(error), level: .failure)
        }
    }

    /// "…k9x2 · last used Sep 1, 2026" — the token row's line.
    public func tokenLine(_ token: McpToken) -> String {
        let used = token.lastUsedAt.map { "last used \(IsoDate.shortDay($0))" } ?? "never used"
        return "…\(token.tokenLast4) · \(used)"
    }

    public func connectionLine(_ connection: McpConnection) -> String {
        "signed in \(IsoDate.shortDay(connection.createdAt))"
    }
}

extension IsoDate {
    /// "Sep 8, 2026" — a created or last-used stamp for a settings row, where
    /// the raw `2026-09-08` read as a database column (ux-review §3.8). Built
    /// from the date part rather than the instant, like the web's
    /// `created_at.slice(0, 10)`, so the day never slides across a zone.
    static func shortDay(_ iso: String) -> String {
        guard let key = DayKey(String(iso.prefix(10))) else { return day(iso) }
        return "\(MonthNames.short[key.month - 1]) \(key.day), \(key.year)"
    }
}

/// `sheet(item:)` wants an identity; the mint's row id is one.
extension MintedMcpToken: @retroactive Identifiable {}
