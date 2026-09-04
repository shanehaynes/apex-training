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

    /// The handler is POST-only and reads `{ tool, args }` from the body; keys
    /// are sorted so the same call always produces the same bytes.
    func testQueryIsAPostWithASortedBody() {
        let endpoint = Endpoint.query(tool: "get_meals", args: ["start_date": "2026-09-08", "include_items": true, "limit": 20])
        XCTAssertEqual(endpoint.method, .post)
        XCTAssertEqual(endpoint.url(relativeTo: base)?.absoluteString, "http://127.0.0.1:5314/api/query")
        XCTAssertEqual(String(decoding: endpoint.body!, as: UTF8.self),
                       #"{"args":{"include_items":true,"limit":20,"start_date":"2026-09-08"},"tool":"get_meals"}"#)
        XCTAssertEqual(String(decoding: Endpoint.query(tool: "get_prs").body!, as: UTF8.self), #"{"args":{},"tool":"get_prs"}"#)
    }

    func testJSONValueRoundTrips() throws {
        let value: JSONValue = ["a": [1, 2.5, true, nil, "s"], "b": ["c": 3]]
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
    }

    func testTrailingSlashOnTheBaseDoesNotDoubleUp() {
        let slashed = URL(string: "http://127.0.0.1:5314/")!
        XCTAssertEqual(
            Endpoint.profile.url(relativeTo: slashed)?.absoluteString,
            "http://127.0.0.1:5314/api/profile"
        )
    }
}
