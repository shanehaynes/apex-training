import ApexCore
import ApexFeatures
import Foundation

extension YouTransport {
    /// Every Blocks route answered from its fixture: the list read, the
    /// writes, the cycle preview (its ok answer; tests swap in the others).
    static func blocks() -> YouTransport {
        let t = YouTransport()
        t.set("POST /api/query get_training_blocks", .json(200, fixture("query-get_training_blocks.json")))
        t.set("POST /api/blocks?resource=cycle", .json(200, fixture("blocks-cycle.json")))
        t.set("POST /api/blocks?batch=1", .json(200, Data(#"{"ids":["blk-c1","blk-c2","blk-c3","blk-c4"]}"#.utf8)))
        t.set("POST /api/blocks", .json(200, Data(#"{"id":"blk-new"}"#.utf8)))
        t.set("PATCH /api/blocks", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("DELETE /api/blocks", .json(200, Data(#"{"ok":true}"#.utf8)))
        t.set("POST /api/objectives", .json(200, Data(#"{"id":"obj-new"}"#.utf8)))
        return t
    }

    /// The detail read, for a test that loads one block's progress.
    func answerDetail() {
        set("POST /api/query get_training_blocks", .json(200, Self.fixture("query-get_training_blocks-detail.json")))
    }
}

@MainActor
func makeBlocksModel(_ transport: YouTransport, cache: any CacheStore = MemoryCacheStore(), realtime: (any RealtimeChanges)? = nil) -> BlocksModel {
    let client = ApexClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokens: CoachTestTokens())
    let model = BlocksModel(deps: BlocksDependencies(
        client: client, cache: cache, clock: TestClock(now: coachTestNow), realtime: realtime, timeZone: TimeZone(identifier: "UTC")!
    ))
    model.previewDelay = .zero
    return model
}
