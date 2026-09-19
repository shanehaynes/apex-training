import ApexCore
import ApexFeatures
import XCTest
@testable import Apex

/// Deleting the account clears what this device kept for that owner (#220).
/// Sign-out keeps the write queue on purpose — an ordinary session ends with
/// work still worth flushing — and nothing ever cleared the coach's
/// conversations, so the next account on the phone inherited a queue that
/// 404s forever and a stranger's history.
final class AppModelAccountDeletionTests: XCTestCase {
    private let session = SessionKey(eventId: "ios-fixture-run", eventDate: "2026-09-08")

    @MainActor
    func testAccountDeletionClearsConversationsAndTheWriteQueue() async throws {
        let model = AppModel(mock: MockEnvironment())
        _ = await model.signIn(email: "a@apex.local", password: "hunter2")
        model.ensureQueue(owner: "owner-a", email: "a@apex.local")
        let queue = try XCTUnwrap(model.trackerServices?.queue)
        let store = try XCTUnwrap(model.coachServices?.store)

        // Paused, or `ensureQueue`'s opening flush sends the op to the fixture
        // backend and there is nothing left for the deletion to purge.
        await queue.pause()
        _ = try await queue.enqueue(.start(startedAt: "2026-09-08T12:00:00.000Z"), for: session)
        try await store.create(Conversation(
            id: "c1", mode: .chat, title: "The deleted account's thread",
            createdAt: Date(timeIntervalSince1970: 1_788_868_800),
            updatedAt: Date(timeIntervalSince1970: 1_788_868_800)
        ))

        model.accountDeleted()
        let signedOut = await waitFor {
            if case .signedOut = model.state { return true }
            return false
        }
        XCTAssertTrue(signedOut, "deleting the account signs the device out")

        // Read through the handles captured above: sign-out drops the model's.
        let ops = await queue.pendingOps(for: session)
        XCTAssertEqual(ops, [], "queued writes for a deleted account would 404 forever")
        let conversations = try await store.conversations(mode: .chat)
        XCTAssertEqual(conversations, [], "the deleted account's coach history must not stay on disk")
    }
}
