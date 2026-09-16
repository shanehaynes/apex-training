import XCTest
@testable import ApexCore

/// D-032: the one `src/lib/nutrition` function that runs on the phone, pinned
/// against vectors the web repo computes with its own `derivedCalories` and
/// emits to `ios/Fixtures/nutrition-derived.json`. A drift on either side
/// fails here, not in a composer showing a different number than the web.
final class NutritionContractTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Vector: Decodable {
            struct Input: Decodable {
                let proteinG: Double?
                let carbsG: Double?
                let fatTotalG: Double?
                let alcoholG: Double?
            }
            let input: Input
            let output: Int?
        }
        let vectors: [Vector]
    }

    private static let fixture: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ApexCoreTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // ApexCore
        .deletingLastPathComponent()  // Packages
        .deletingLastPathComponent()  // ios
        .appendingPathComponent("Fixtures")
        .appendingPathComponent("nutrition-derived.json")

    func testEveryEmittedVectorMatchesThePort() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: Self.fixture)).vectors
        XCTAssertGreaterThan(vectors.count, 5)
        for vector in vectors {
            let ours = Nutrition.derivedCalories(
                proteinG: vector.input.proteinG, carbsG: vector.input.carbsG,
                fatTotalG: vector.input.fatTotalG, alcoholG: vector.input.alcoholG
            )
            XCTAssertEqual(ours, vector.output, "\(vector.input)")
        }
        // The two cases the port could plausibly get wrong are in the file.
        XCTAssertTrue(vectors.contains { $0.output == nil }, "the nothing-set → nil vector")
        XCTAssertTrue(vectors.contains { $0.input.carbsG == 0.125 && $0.output == 1 }, "the half-rounds-up vector")
    }
}
