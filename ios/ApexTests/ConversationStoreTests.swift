import ApexCore
import XCTest
import ApexPersistence

/// `conversations` / `messages` over a temp-file pool: round trips, ordering,
/// owner scoping, the cascade, the grown row, and a relaunch read.
final class ConversationStoreTests: XCTestCase {
    private func makePool() throws -> DatabasePoolBox {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("apex-conv-\(UUID().uuidString).sqlite")
        return DatabasePoolBox(pool: try ApexDatabase.makePool(at: url))
    }

    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func conversation(_ id: String, at seconds: TimeInterval = 0) -> Conversation {
        Conversation(id: id, mode: .chat, title: "Title \(id)", createdAt: t0.addingTimeInterval(seconds), updatedAt: t0.addingTimeInterval(seconds))
    }

    private func row(_ id: String, in conversation: String, role: ApiMessage.Role = .user, api: ApiMessage.Content? = .text("hi"),
                     display: String? = "hi", kind: StoredMessage.Kind = .turn, at seconds: TimeInterval = 0) -> StoredMessage {
        StoredMessage(id: id, conversationId: conversation, role: role, apiContent: api, displayText: display, kind: kind,
                      createdAt: t0.addingTimeInterval(seconds))
    }

    func testCreateAppendAndReadBackEveryField() async throws {
        let pool = try makePool()
        let store = GRDBConversationStore(pool: pool.pool, owner: "u1")
        try await store.create(conversation("a"))
        let blocks: ApiMessage.Content = .blocks([
            .text("On it."),
            .toolUse(ToolUseBlock(id: "tu_1", name: "delete_event", input: ["event_id": "e"], label: "Delete: E")),
        ])
        try await store.append(row("m1", in: "a"))
        try await store.append(row("m2", in: "a", role: .assistant, api: blocks, display: "On it.", at: 1))
        try await store.append(row("m3", in: "a", role: .assistant, api: nil, display: "Stopped text", kind: .stopped, at: 2))

        let rows = try await store.messages(in: "a")
        XCTAssertEqual(rows.map(\.id), ["m1", "m2", "m3"])
        XCTAssertEqual(rows[1].apiContent, blocks)
        XCTAssertEqual(rows[1].apiMessage?.toolUses.first?.label, "Delete: E")
        XCTAssertEqual(rows[2].kind, .stopped)
        XCTAssertNil(rows[2].apiContent)
        XCTAssertEqual(rows[0].createdAt.timeIntervalSince1970, 1_000)

        let stored = try await store.conversation(id: "a")
        XCTAssertEqual(stored?.title, "Title a")
        XCTAssertEqual(stored?.mode, .chat)
    }

    func testConversationsOrderNewestUpdatedFirstAndTouchReorders() async throws {
        let pool = try makePool()
        let store = GRDBConversationStore(pool: pool.pool, owner: "u1")
        try await store.create(conversation("a", at: 1))
        try await store.create(conversation("b", at: 2))
        try await store.create(conversation("c", at: 3))
        var ids = try await store.conversations(mode: .chat).map(\.id)
        XCTAssertEqual(ids, ["c", "b", "a"])
        try await store.touch(id: "a", at: t0.addingTimeInterval(10))
        ids = try await store.conversations(mode: .chat).map(\.id)
        XCTAssertEqual(ids, ["a", "c", "b"])
        try await store.setTitle(id: "b", title: "renamed")
        let b = try await store.conversation(id: "b")
        XCTAssertEqual(b?.title, "renamed")
    }

    func testOwnerScoping() async throws {
        let pool = try makePool()
        let mine = GRDBConversationStore(pool: pool.pool, owner: "u1")
        let theirs = GRDBConversationStore(pool: pool.pool, owner: "u2")
        try await mine.create(conversation("a"))
        try await mine.append(row("m1", in: "a"))
        let theirList = try await theirs.conversations(mode: .chat)
        XCTAssertEqual(theirList, [])
        let theirRows = try await theirs.messages(in: "a")
        XCTAssertEqual(theirRows, [])
        let theirLookup = try await theirs.conversation(id: "a")
        XCTAssertNil(theirLookup)
        // Nor can the other owner delete it.
        try await theirs.delete(id: "a")
        let stillMine = try await mine.messages(in: "a")
        XCTAssertEqual(stillMine.count, 1)
    }

    func testDeleteCascadesMessagesAndDeleteAllClearsTheOwner() async throws {
        let pool = try makePool()
        let store = GRDBConversationStore(pool: pool.pool, owner: "u1")
        try await store.create(conversation("a"))
        try await store.create(conversation("b"))
        try await store.append(row("m1", in: "a"))
        try await store.append(row("m2", in: "b"))
        try await store.delete(id: "a")
        let aRows = try await store.messages(in: "a")
        XCTAssertEqual(aRows, [])
        let remaining = try await store.conversations(mode: .chat).map(\.id)
        XCTAssertEqual(remaining, ["b"])
        try await store.deleteAll()
        let none = try await store.conversations(mode: .chat)
        XCTAssertEqual(none, [])
    }

    func testUpdateGrowsTheToolResultRowInPlace() async throws {
        let pool = try makePool()
        let store = GRDBConversationStore(pool: pool.pool, owner: "u1")
        try await store.create(conversation("a"))
        var results = row("m1", in: "a", api: .blocks([.toolResult(ToolResult(toolUseId: "tu_1", content: "Done."))]), display: nil)
        try await store.append(results)
        try await store.append(row("m2", in: "a", role: .assistant, api: .text("later"), display: "later", at: 5))
        results.apiContent = .blocks([
            .toolResult(ToolResult(toolUseId: "tu_1", content: "Done.")),
            .toolResult(ToolResult(toolUseId: "tu_2", content: "Cancelled by user.")),
            .text("and?"),
        ])
        results.displayText = "and?"
        try await store.update(results)
        let rows = try await store.messages(in: "a")
        XCTAssertEqual(rows.map(\.id), ["m1", "m2"])
        XCTAssertEqual(rows[0].apiContent?.blocks?.count, 3)
        XCTAssertEqual(rows[0].displayText, "and?")
    }

    func testRelaunchReadsBackThroughANewStoreInstance() async throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("apex-conv-relaunch-\(UUID().uuidString).sqlite")
        do {
            let store = GRDBConversationStore(pool: try ApexDatabase.makePool(at: url), owner: "u1")
            try await store.create(conversation("a"))
            try await store.append(row("m1", in: "a"))
        }
        let again = GRDBConversationStore(pool: try ApexDatabase.makePool(at: url), owner: "u1")
        let list = try await again.conversations(mode: .chat)
        XCTAssertEqual(list.map(\.id), ["a"])
        let rows = try await again.messages(in: "a")
        XCTAssertEqual(rows.map(\.displayText), ["hi"])
    }
}
