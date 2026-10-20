import ApexCore
import Foundation
import XCTest
@testable import Apex

/// The mock's hand-written JSON replies. They are raw strings (`#"…"#`), where
/// `\(…)` is literal text and only `\#(…)` interpolates — so a slip sends the
/// app `{"id":"\(id)"}` instead of the id, and nothing else in the suite reads
/// these replies closely enough to notice.
final class MockReplyTests: XCTestCase {
    private func reply(
        _ method: String, _ path: String, body: [String: Any]? = nil,
        on transport: FixtureTransport? = nil
    ) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1\(path)")!)
        request.httpMethod = method
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let response = if let transport {
            try await transport.send(request)
        } else {
            try await MockEnvironment(termsStale: false).transport.send(request)
        }
        XCTAssertEqual(response.status, 200, "\(method) \(path)")
        let text = String(decoding: response.body, as: UTF8.self)
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        return try XCTUnwrap(object, "\(method) \(path) is not a JSON object: \(text)")
    }

    func testTemplateArchiveEchoesTheQueryId() async throws {
        let object = try await reply("PATCH", "/api/workout-templates?id=tmpl-1", body: ["archived_at": "2026-09-08T12:00:00.000Z"])
        XCTAssertEqual(object["id"] as? String, "tmpl-1")
    }

    func testDefinitionCreateEchoesTheBodyId() async throws {
        let object = try await reply("POST", "/api/exercise-definitions", body: ["id": "def-1", "canonical_name": "Mock Press"])
        XCTAssertEqual(object["id"] as? String, "def-1")
    }

    func testTileDeleteEchoesTheQueryId() async throws {
        let object = try await reply("DELETE", "/api/analytics-tiles?id=ios-fixture-tile-tonnage")
        XCTAssertEqual(object["id"] as? String, "ios-fixture-tile-tonnage")
    }

    func testTileSaveWithoutADraftEchoesTheBodyId() async throws {
        let object = try await reply("POST", "/api/analytics-tiles", body: ["id": "tile-1"])
        XCTAssertEqual(object["id"] as? String, "tile-1")
    }

    /// One transport throughout: the default is `true`, so only the round trip
    /// off and back on proves the reply follows the body.
    func testCorosAutoSyncReportsTheNewValue() async throws {
        let transport = await MockEnvironment(termsStale: false).transport
        let off = try await reply("POST", "/api/provider-sync", body: ["action": "set-auto-sync", "enabled": false], on: transport)
        XCTAssertEqual(off["autoSync"] as? Bool, false)
        let offStatus = try await reply("POST", "/api/provider-sync", body: ["action": "status"], on: transport)
        XCTAssertEqual((offStatus["coros"] as? [String: Any])?["autoSync"] as? Bool, false)
        let on = try await reply("POST", "/api/provider-sync", body: ["action": "set-auto-sync", "enabled": true], on: transport)
        XCTAssertEqual(on["autoSync"] as? Bool, true)
        let onStatus = try await reply("POST", "/api/provider-sync", body: ["action": "status"], on: transport)
        XCTAssertEqual((onStatus["coros"] as? [String: Any])?["autoSync"] as? Bool, true)
    }
}
