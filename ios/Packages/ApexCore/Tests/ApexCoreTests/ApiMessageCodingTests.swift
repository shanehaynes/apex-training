import XCTest
@testable import ApexCore

/// The wire shapes must match the web byte for byte: `/api/chat` forwards
/// `messages` to the Anthropic API as is.
final class ApiMessageCodingTests: XCTestCase {
    private func encode(_ message: ApiMessage) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(message), as: UTF8.self)
    }

    func testUserStringEncodesAsTheWebShape() throws {
        XCTAssertEqual(try encode(.user("hi")), #"{"content":"hi","role":"user"}"#)
        XCTAssertEqual(try encode(.assistant("yo")), #"{"content":"yo","role":"assistant"}"#)
    }

    func testUserBlocksEncodeToolResultKeys() throws {
        let message = ApiMessage(role: .user, content: .blocks([
            .toolResult(ToolResult(toolUseId: "tu_1", content: "Done.")), .text("and?"),
        ]))
        XCTAssertEqual(
            try encode(message),
            #"{"content":[{"content":"Done.","tool_use_id":"tu_1","type":"tool_result"},{"text":"and?","type":"text"}],"role":"user"}"#
        )
    }

    func testAssistantBlocksEncodeToolUseWithAnInputObject() throws {
        let message = ApiMessage(role: .assistant, content: .blocks([
            .text("Clearing it."),
            .toolUse(ToolUseBlock(id: "tu_1", name: "delete_event", input: ["event_id": "e", "scope": "instance"])),
        ]))
        XCTAssertEqual(
            try encode(message),
            #"{"content":[{"text":"Clearing it.","type":"text"},{"id":"tu_1","input":{"event_id":"e","scope":"instance"},"name":"delete_event","type":"tool_use"}],"role":"assistant"}"#
        )
    }

    func testDecodesTheWebShapes() throws {
        let json = #"[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"text","text":"On it."},{"type":"tool_use","id":"tu_1","name":"delete_event","input":{"event_id":"e"},"label":"Delete: E"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"Done."}]}]"#
        let messages = try JSONDecoder().decode([ApiMessage].self, from: Data(json.utf8))
        XCTAssertEqual(messages[0], .user("hi"))
        XCTAssertEqual(messages[1].toolUses, [ToolUseBlock(id: "tu_1", name: "delete_event", input: ["event_id": "e"], label: "Delete: E")])
        XCTAssertEqual(messages[2].toolResults, [ToolResult(toolUseId: "tu_1", content: "Done.")])
    }

    func testLabelRoundTripsLocallyAndStripsForTheWire() throws {
        let stored = ApiMessage(role: .assistant, content: .blocks([
            .toolUse(ToolUseBlock(id: "tu_1", name: "delete_event", input: [:], label: "Delete: E")),
        ]))
        let data = try JSONEncoder().encode(stored)
        XCTAssertEqual(try JSONDecoder().decode(ApiMessage.self, from: data), stored)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"label\""))

        let wire = try encode(stored.strippingLabels())
        XCTAssertFalse(wire.contains("label"))
        XCTAssertEqual(wire, #"{"content":[{"id":"tu_1","input":{},"name":"delete_event","type":"tool_use"}],"role":"assistant"}"#)
    }

    func testToolUseBlockFromTheWireEventRefusesNonObjectInput() throws {
        let object = try JSONDecoder().decode(ChatWireEvent.self, from: Data(
            #"{"type":"tool_use","id":"t","name":"delete_event","input":{"a":1},"label":"L"}"#.utf8
        ))
        XCTAssertEqual(ToolUseBlock(object), ToolUseBlock(id: "t", name: "delete_event", input: ["a": 1], label: "L"))
        let array = try JSONDecoder().decode(ChatWireEvent.self, from: Data(
            #"{"type":"tool_use","id":"t","name":"delete_event","input":[1]}"#.utf8
        ))
        XCTAssertNil(ToolUseBlock(array))
        XCTAssertNil(ToolUseBlock(.done))
    }
}
