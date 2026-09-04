import SwiftUI
import XCTest
import ApexUI

final class DesignSystemTests: XCTestCase {
    /// A missing or renamed TTF degrades silently to San Francisco — the app
    /// still runs and nobody notices until a screenshot looks wrong. This is the
    /// only place that failure is loud.
    @MainActor
    func testEveryBundledFontRegistersAndResolves() {
        ApexFonts.register()
        for name in ApexFonts.postScriptNames {
            XCTAssertNotNil(
                UIFont(name: name, size: 12),
                "\(name) did not register — is the TTF in ApexUI/Resources/Fonts?"
            )
        }
    }

    @MainActor
    func testRegistrationIsIdempotent() {
        ApexFonts.register()
        ApexFonts.register()
        XCTAssertNotNil(UIFont(name: "Inter-Regular", size: 12))
    }

    @MainActor
    func testHexInitialiserMatchesTheWebPalette() {
        let components = UIColor(Color(hex: 0x0D0C0B)).cgColor.components ?? []
        XCTAssertEqual(components[0], 13 / 255, accuracy: 0.001)
        XCTAssertEqual(components[1], 12 / 255, accuracy: 0.001)
        XCTAssertEqual(components[2], 11 / 255, accuracy: 0.001)
    }

    /// The generator is the only writer of Tokens.swift; this asserts the values
    /// arrived, not that they are pretty.
    @MainActor
    func testGeneratedTokensCarryTheHouseValues() {
        XCTAssertEqual(WorkoutTypeTokens.byRawValue.count, 7)
        XCTAssertEqual(WorkoutTypeTokens.byRawValue["weights"]?.label, "Strength")
        XCTAssertEqual(WorkoutTypeTokens.byRawValue["outdoor-climbing"]?.label, "Outdoor Climbing")
        XCTAssertEqual(ChartPalette.seriesRamp.count, 8)
        XCTAssertEqual(Radius.md, 8)
        XCTAssertEqual(Motion.base, 0.25, accuracy: 0.0001)
    }

    /// An unknown type must render as a neutral chip rather than trap.
    @MainActor
    func testTypeChipFallsBackForAnUnknownType() {
        _ = TypeChip(rawType: "surfing")
    }

    /// A symbol name that does not exist renders nothing, silently.
    @MainActor
    func testEveryIconResolvesToASymbol() {
        for icon in ApexIcon.allCases {
            XCTAssertNotNil(UIImage(systemName: icon.systemName), "\(icon) → \(icon.systemName) is not an SF Symbol")
        }
    }
}
