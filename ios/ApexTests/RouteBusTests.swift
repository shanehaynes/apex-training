import ApexCore
import ApexFeatures
import XCTest

/// The route bus and the tracker resolver (W12): a link selects its tab and
/// waits for its consumer; the resolver finds the occurrence or says no.
final class RouteBusTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

    private static let index: ScheduleIndex = {
        let data = try! Data(contentsOf: fixtures.appendingPathComponent("schedule.json"))
        return ScheduleIndex(try! JSONDecoder().decode(ScheduleResponse.self, from: data))
    }()

    @MainActor
    func testTrackerLinkSelectsScheduleAndWaitsForItsConsumer() {
        let bus = RouteBus()
        bus.tab = .coach
        bus.open(.tracker(id: "e", date: "2026-09-22"))
        XCTAssertEqual(bus.tab, .schedule)
        XCTAssertEqual(bus.pending, .tracker(id: "e", date: "2026-09-22"))

        // A consumer that does not handle it leaves it parked.
        XCTAssertNil(bus.take { if case .library = $0 { true } else { false } })
        XCTAssertNotNil(bus.pending)
        XCTAssertEqual(bus.take { if case .tracker = $0 { true } else { false } }, .tracker(id: "e", date: "2026-09-22"))
        XCTAssertNil(bus.pending)
    }

    @MainActor
    func testLibraryGoesToYouAndAuthLinksAreNotRoutes() {
        let bus = RouteBus()
        bus.open(.library(definitionId: "d"))
        XCTAssertEqual(bus.tab, .you)
        bus.open(.connected(provider: "coros"))
        XCTAssertEqual(bus.pending, .library(definitionId: "d"), "a non-route never displaces a parked route")
    }

    @MainActor
    func testResolverFindsTheOccurrenceOnItsDate() {
        let route = TrackerRouteResolver.route(for: .tracker(id: "ios-fixture-weekly__2026-09-22", date: "2026-09-22"), in: Self.index)
        XCTAssertEqual(route?.event.id, "ios-fixture-weekly__2026-09-22")
        XCTAssertNil(TrackerRouteResolver.route(for: .tracker(id: "ios-fixture-weekly__2026-09-22", date: "2026-09-23"), in: Self.index),
                     "the date is part of the key")
        XCTAssertNil(TrackerRouteResolver.route(for: .tracker(id: "nope", date: "2026-09-22"), in: Self.index))
        XCTAssertNil(TrackerRouteResolver.route(for: .tracker(id: "ios-fixture-weekly__2026-09-22", date: "2026-09-22"), in: nil),
                     "no index yet — the consumer waits")
        XCTAssertNil(TrackerRouteResolver.route(for: .event(id: "ios-fixture-weekly__2026-09-22", date: "2026-09-22"), in: Self.index))
    }
}
