import XCTest
@testable import ApexCore

final class SlugTests: XCTestCase {
    func testSlugifiesLikeTheWeb() {
        XCTAssertEqual(Slug.name("90/90 Hip Stretch"), "90-90-hip-stretch")
        XCTAssertEqual(Slug.name("  Bulgarian   Split-Squat  "), "bulgarian-split-squat")
        XCTAssertEqual(Slug.name("Pull-Up (weighted)"), "pull-up-weighted")
        XCTAssertEqual(Slug.name("---"), "")
        XCTAssertEqual(Slug.name("Café Row"), "caf-row")
    }
}
