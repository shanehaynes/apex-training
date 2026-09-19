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

    /// G8: the header every request carries. The Info.plist substitutions are
    /// the part that breaks silently, so assert on the shape rather than on a
    /// version number that changes every release.
    @MainActor
    func testClientTagNamesThePlatformVersionAndBuild() {
        XCTAssertTrue(AppConfig.clientTag.hasPrefix("ios/"), AppConfig.clientTag)
        XCTAssertTrue(AppConfig.clientTag.contains("+"), AppConfig.clientTag)
        XCTAssertFalse(AppConfig.clientTag.hasSuffix("+"), "CFBundleVersion did not substitute")
        XCTAssertFalse(AppConfig.clientTag.contains("$("), "an Info.plist key did not substitute")
    }

    /// A build number the gate cannot read is a build the gate never blocks,
    /// so a zero here would silently disarm G8 for every shipped build.
    @MainActor
    func testBuildNumberIsReadable() {
        XCTAssertGreaterThan(AppConfig.buildNumber, 0)
    }

    /// Empty until the app has an App Store listing; the update screen then
    /// states the requirement without offering a dead link. What must never
    /// happen is an unsubstituted or unparseable value becoming a Link.
    @MainActor
    func testAppStoreURLIsEitherAbsentOrReal() {
        guard let url = AppConfig.appStoreURL else { return }
        XCTAssertEqual(url.scheme, "https")
        XCTAssertNotNil(url.host())
    }
}
