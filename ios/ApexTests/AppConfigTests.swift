import XCTest
@testable import Apex

/// The build configuration actually reaching the app. These read the same
/// Info.plist the shipped binary reads, so a broken xcconfig fails here rather
/// than at launch on a device.
final class AppConfigTests: XCTestCase {
    @MainActor
    func testLocalConfigurationPointsAtTheLocalStack() {
        XCTAssertEqual(AppConfig.name, "Local", "run the Apex scheme's Local configuration")
        XCTAssertEqual(AppConfig.supabaseURL.host(), "127.0.0.1")
        XCTAssertEqual(AppConfig.apiBase.host(), "127.0.0.1")
    }

    @MainActor
    func testAnonKeyIsPresentAndNotThePlaceholder() {
        XCTAssertNotEqual(AppConfig.supabaseAnonKey, "REPLACE_ME")
        XCTAssertFalse(AppConfig.supabaseAnonKey.isEmpty)
    }

    /// The xcconfig SLASH dance is easy to get wrong and fails silently — a
    /// truncated "http:" parses as a URL but has no host.
    @MainActor
    func testUrlsSurvivedTheXcconfigCommentTrap() {
        XCTAssertEqual(AppConfig.apiBase.scheme, "http")
        XCTAssertNotNil(AppConfig.apiBase.port)
    }

    @MainActor
    func testAssertSafePassesUnderLocal() {
        AppConfig.assertSafe()
    }
}
