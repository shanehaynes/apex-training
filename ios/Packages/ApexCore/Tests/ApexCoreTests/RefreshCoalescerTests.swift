import XCTest
@testable import ApexCore

final class RefreshCoalescerTests: XCTestCase {
    func testABurstYieldsOneSurvivor() async {
        let coalescer = RefreshCoalescer<String>(quiet: 0.05)
        let results = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
            for _ in 0..<5 { group.addTask { await coalescer.request("schedule") } }
            var out: [Bool] = []
            for await r in group { out.append(r) }
            return out
        }
        XCTAssertEqual(results.filter { $0 }.count, 1)
        XCTAssertEqual(results.count, 5)
    }

    func testKeysAreIndependent() async {
        let coalescer = RefreshCoalescer<String>(quiet: 0.02)
        async let a = coalescer.request("schedule")
        async let b = coalescer.request("meals")
        let (ra, rb) = await (a, b)
        XCTAssertTrue(ra)
        XCTAssertTrue(rb)
    }

    func testAQuietRequestSurvives() async {
        let coalescer = RefreshCoalescer<String>(quiet: 0.01)
        let first = await coalescer.request("x")
        let second = await coalescer.request("x")
        XCTAssertTrue(first)
        XCTAssertTrue(second)
    }
}
