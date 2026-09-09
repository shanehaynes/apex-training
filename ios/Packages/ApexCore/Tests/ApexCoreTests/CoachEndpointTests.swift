import XCTest
@testable import ApexCore

final class CoachEndpointTests: XCTestCase {
    private func body(_ endpoint: Endpoint) -> String { String(decoding: endpoint.body!, as: UTF8.self) }

    private let toolUse = ToolUseBlock(id: "tu_1", name: "delete_event", input: ["event_id": "e", "scope": "instance"], label: "Delete: E")

    func testChatBodyKeysAndOrder() {
        let endpoint = Endpoint.chat(mode: .chat, messages: [.user("hi")], withTools: true, today: "2026-09-08")
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "api/chat")
        XCTAssertEqual(body(endpoint), #"{"messages":[{"content":"hi","role":"user"}],"mode":"chat","today":"2026-09-08","withTools":true}"#)
    }

    func testChatOmitsModelWhenNilAndIncludesItWhenSet() {
        XCTAssertFalse(body(Endpoint.chat(mode: .chat, messages: [], withTools: false, today: "d")).contains("model"))
        XCTAssertTrue(body(Endpoint.chat(mode: .chat, messages: [], withTools: false, today: "d", model: "claude-sonnet-5"))
            .contains(#""model":"claude-sonnet-5""#))
    }

    func testChatIncludesTheDraftContextForTheBuilder() {
        let endpoint = Endpoint.chat(mode: .builder, messages: [], withTools: true, today: "d", draft: ["title": "Leg day"])
        XCTAssertEqual(body(endpoint), #"{"context":{"draft":{"title":"Leg day"}},"messages":[],"mode":"builder","today":"d","withTools":true}"#)
    }

    /// The API rejects unknown fields on a tool_use block: the server label is
    /// for the card only and never goes back.
    func testChatStripsEveryLabel() {
        let history: [ApiMessage] = [
            .user("go"),
            ApiMessage(role: .assistant, content: .blocks([.text("On it."), .toolUse(toolUse)])),
            .user(toolResults: [ToolResult(toolUseId: "tu_1", content: "Done.")]),
        ]
        let text = body(Endpoint.chat(mode: .chat, messages: history, withTools: false, today: "d"))
        XCTAssertFalse(text.contains("label"))
        XCTAssertTrue(text.contains(#"{"id":"tu_1","input":{"event_id":"e","scope":"instance"},"name":"delete_event","type":"tool_use"}"#))
        XCTAssertTrue(text.contains(#"{"content":"Done.","tool_use_id":"tu_1","type":"tool_result"}"#))
    }

    func testCoachToolBody() {
        let endpoint = Endpoint.coachTool(toolUseId: "tu_1", name: "delete_event", input: ["event_id": "e"], today: "2026-09-08")
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.path, "api/coach-tool")
        XCTAssertEqual(body(endpoint), #"{"input":{"event_id":"e"},"name":"delete_event","today":"2026-09-08","toolUseId":"tu_1"}"#)
    }

    func testSetAnthropicKeyIsAPatchAndNullRemoves() {
        let save = Endpoint.setAnthropicKey("sk-ant-api03-x")
        XCTAssertEqual(save.method, .patch)
        XCTAssertEqual(save.path, "api/profile")
        XCTAssertEqual(body(save), #"{"anthropic_api_key":"sk-ant-api03-x"}"#)
        XCTAssertEqual(body(Endpoint.setAnthropicKey(nil)), #"{"anthropic_api_key":null}"#)
    }
}
