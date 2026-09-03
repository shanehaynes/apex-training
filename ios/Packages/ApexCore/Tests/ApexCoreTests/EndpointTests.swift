import XCTest
@testable import ApexCore

final class EndpointTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:5314")!

    func testScheduleURL() {
        let url = Endpoint.schedule(start: "2026-09-01", end: "2026-09-30").url(relativeTo: base)
        XCTAssertEqual(url?.absoluteString, "http://127.0.0.1:5314/api/schedule?start=2026-09-01&end=2026-09-30")
    }

    func testScheduleJoinsIncludes() {
        let url = Endpoint.schedule(start: "a", end: "b", include: ["definitions", "templates"])
            .url(relativeTo: base)
        XCTAssertEqual(url?.query, "start=a&end=b&include=definitions,templates")
    }

    /// Arguments are sorted so the same call always produces the same URL — a
    /// cache key that reshuffles is a cache that never hits.
    func testQueryArgumentsAreOrderStable() {
        let url = Endpoint.query(tool: "get_prs", arguments: ["scope": "all_time", "exercise": "Press"])
            .url(relativeTo: base)
        XCTAssertEqual(url?.query, "tool=get_prs&exercise=Press&scope=all_time")
    }

    func testTrailingSlashOnTheBaseDoesNotDoubleUp() {
        let slashed = URL(string: "http://127.0.0.1:5314/")!
        XCTAssertEqual(
            Endpoint.profile.url(relativeTo: slashed)?.absoluteString,
            "http://127.0.0.1:5314/api/profile"
        )
    }
}
