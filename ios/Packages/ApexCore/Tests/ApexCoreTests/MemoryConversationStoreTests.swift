import XCTest
@testable import ApexCore

final class MemoryConversationStoreTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func conversation(_ id: String, mode: ChatMode = .chat, at seconds: TimeInterval) -> Conversation {
        let date = t0.addingTimeInterval(seconds)
        return Conversation(id: id, mode: mode, title: id, createdAt: date, updatedAt: date)
    }

    private func row(_ id: String, in conversation: String, text: String) -> StoredMessage {
        StoredMessage(id: id, conversationId: conversation, role: .user, apiContent: .text(text), displayText: text, kind: .turn, createdAt: t0)
    }

    func testCreateListsNewestUpdatedFirstPerMode() async throws {
        let store = MemoryConversationStore()
        try await store.create(conversation("a", at: 1))
        try await store.create(conversation("b", at: 2))
        try await store.create(conversation("builder", mode: .builder, at: 3))
        let v1 = try await store.conversations(mode: .chat).map(\.id)
        XCTAssertEqual(v1, ["b", "a"])
        let v2 = try await store.conversations(mode: .builder).map(\.id)
        XCTAssertEqual(v2, ["builder"])
    }

    func testAppendKeepsInsertionOrder() async throws {
        let store = MemoryConversationStore()
        try await store.create(conversation("a", at: 1))
        try await store.append(row("m1", in: "a", text: "one"))
        try await store.append(row("m2", in: "a", text: "two"))
        let v3 = try await store.messages(in: "a").map(\.id)
        XCTAssertEqual(v3, ["m1", "m2"])
    }

    func testUpdateReplacesTheRowInPlace() async throws {
        let store = MemoryConversationStore()
        try await store.create(conversation("a", at: 1))
        try await store.append(row("m1", in: "a", text: "one"))
        try await store.append(row("m2", in: "a", text: "two"))
        var grown = row("m1", in: "a", text: "one")
        grown.apiContent = .blocks([.toolResult(ToolResult(toolUseId: "t", content: "Done."))])
        grown.displayText = nil
        try await store.update(grown)
        let rows = try await store.messages(in: "a")
        XCTAssertEqual(rows.map(\.id), ["m1", "m2"])
        XCTAssertEqual(rows[0].apiContent?.blocks?.count, 1)
        XCTAssertNil(rows[0].displayText)
    }

    func testDeleteCascadesMessages() async throws {
        let store = MemoryConversationStore()
        try await store.create(conversation("a", at: 1))
        try await store.append(row("m1", in: "a", text: "one"))
        try await store.delete(id: "a")
        let v4 = try await store.conversation(id: "a")
        XCTAssertNil(v4)
        let v5 = try await store.messages(in: "a")
        XCTAssertEqual(v5, [])
    }

    func testTouchAndTitleReorderAndRename() async throws {
        let store = MemoryConversationStore()
        try await store.create(conversation("a", at: 1))
        try await store.create(conversation("b", at: 2))
        try await store.touch(id: "a", at: t0.addingTimeInterval(10))
        try await store.setTitle(id: "a", title: "renamed")
        let list = try await store.conversations(mode: .chat)
        XCTAssertEqual(list.map(\.id), ["a", "b"])
        XCTAssertEqual(list[0].title, "renamed")
    }
}
