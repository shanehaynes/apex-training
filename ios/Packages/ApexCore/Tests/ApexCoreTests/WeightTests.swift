import XCTest
@testable import ApexCore

/// `Weight` against the web's own vectors: src/lib/tracking/__tests__/
/// weight.acceptance.test.ts (the grammar) and WorkoutSummary.weight.test.tsx
/// (the volume line). A case that passes there must pass here.
final class WeightTests: XCTestCase {
    private let lb = Weight.Context.default
    private let kg = Weight.Context(unit: .kg, bodyWeightLb: nil)
    private let lbBW = Weight.Context(unit: .lb, bodyWeightLb: 180)
    private let kgBW = Weight.Context(unit: .kg, bodyWeightLb: 180)

    private func lbOf(_ text: String?, _ ctx: Weight.Context) -> Double? { Weight.parse(text, ctx)?.lb }

    func testABareNumberIsAbsoluteInTheContextUnit() {
        XCTAssertEqual(Weight.parse("185", lb), Weight.Parsed(lb: 185, kind: .absolute))
        XCTAssertEqual(lbOf("62.5", lb), 62.5)
        XCTAssertEqual(lbOf("100", kg)!, 220.462, accuracy: 1e-5)
    }

    func testUnitSuffixesWinOverTheContext() {
        for text in ["185lb", "185lbs", "185 lb", "185 lbs", "185LB", "185 Lbs", "185 pounds", "185#"] {
            XCTAssertEqual(lbOf(text, kg), 185, text)
        }
        for text in ["100kg", "100kgs", "100 kg", "100KG", "100Kg", "100KGS", "100 kilos", "100 kilograms"] {
            XCTAssertEqual(lbOf(text, lb)!, 220.462, accuracy: 1e-5, text)
        }
    }

    func testWhitespaceAndATrailingPeriod() {
        for text in ["  185", "185  ", " 185 lb ", "\t185\n", "185 lbs.", "185lbs.", "185 LBS.", "185 lbs. "] {
            XCTAssertEqual(lbOf(text, lb), 185, text)
        }
        XCTAssertEqual(lbOf("185 lb.", kg), 185)
        XCTAssertEqual(lbOf("100 kg.", lb)!, 220.462, accuracy: 1e-5)
        for text in ["185 lbs..", "185 lbs. kg", "185 .lbs", "185."] {
            XCTAssertNil(Weight.parse(text, lb), text)
        }
    }

    func testCommasAreDecimalsUnlessTheyAreThousands() {
        XCTAssertEqual(lbOf("62,5", lb), 62.5)
        XCTAssertEqual(lbOf("62,5 kg", lb)!, 137.78875, accuracy: 1e-5)
        XCTAssertEqual(lbOf("1,200", lb), 1200)
        XCTAssertEqual(lbOf("12,345", lb), 12345)
        XCTAssertEqual(lbOf("1,200", kg)!, 1200 * Weight.lbPerKg, accuracy: 1e-5)
        XCTAssertEqual(lbOf("1,20", lb), 1.2)
        XCTAssertEqual(lbOf("1,2", lb), 1.2)
        XCTAssertEqual(lbOf("1,2000", lb), 1.2)
    }

    func testWhatIsNotAWeight() {
        let rejects = [
            "5.10a", "V5", "100kg x 5", "80%", "heavy", "-10", "+10", "", "   ", "\t",
            "185 5", "185lb5", "185 lb kg", "lb 185", "185l", "100 k", "kg", "lb", "~185", "185-190",
            "1.2.3", "1,2,3", "Infinity", "NaN", "0x10", "1e3", ".5",
        ]
        for text in rejects {
            XCTAssertNil(Weight.parse(text, lb), text)
            XCTAssertNil(Weight.parse(text, kgBW), text)
        }
        XCTAssertNil(Weight.parse(nil, lb))
    }

    func testBodyweightForms() {
        XCTAssertEqual(Weight.parse("BW", lbBW), Weight.Parsed(lb: 180, kind: .bodyweight))
        XCTAssertEqual(lbOf("bw", lbBW), 180)
        XCTAssertEqual(lbOf("  BW  ", lbBW), 180)
        XCTAssertEqual(lbOf("BW", kgBW), 180, "the body weight is pounds under either unit")
        XCTAssertEqual(lbOf("BW+25", lbBW), 205)
        XCTAssertEqual(lbOf("BW-10", lbBW), 170)
        XCTAssertEqual(lbOf("BW+25", kgBW)!, 180 + 25 * Weight.lbPerKg, accuracy: 1e-5)
        XCTAssertEqual(lbOf("BW+25lb", kgBW), 205)
        XCTAssertEqual(lbOf("BW+25 lbs", kgBW), 205)
        XCTAssertEqual(lbOf("BW+25 lbs.", lbBW), 205)
        XCTAssertEqual(lbOf("BW-10kgs", lbBW)!, 157.9538, accuracy: 1e-5)
        for malformed in ["BW25", "BW+", "BW kg", "BW."] {
            XCTAssertNil(Weight.parse(malformed, lbBW), malformed)
        }
        XCTAssertNil(Weight.parse("BW", lb), "no body weight, no BW")
        XCTAssertNil(Weight.parse("BW-200", lbBW), "never zero or less")
    }

    /// The rest of weight.acceptance.test.ts's bodyweight vectors.
    func testMoreBodyweightVectors() {
        XCTAssertEqual(lbOf("bw + 25 lbs", lbBW), 205)
        XCTAssertEqual(lbOf("BW+0", lbBW), 180)
        XCTAssertEqual(lbOf("BW-0", lbBW), 180)
        XCTAssertEqual(lbOf("BW-179", lbBW), 1)
        XCTAssertNil(Weight.parse("BW-180", lbBW))
        XCTAssertNil(Weight.parse("BW-82kg", lbBW), "180 lb less 180.8 lb is nothing")
        XCTAssertEqual(lbOf("BW+2,5kg", lbBW)!, 180 + 2.5 * Weight.lbPerKg, accuracy: 1e-5)
        for malformed in ["+BW", "BW+-25", "BW #", "bwkg", "BW lb"] {
            XCTAssertNil(Weight.parse(malformed, lbBW), malformed)
        }
    }

    /// Where ICU and JavaScript disagree, the web's answer (taken from node).
    func testOnlyJavaScriptsWhitespaceDigitsAndLetters() {
        XCTAssertNil(Weight.parse("100 \u{212A}g", lb), "a Kelvin sign is not a k")
        XCTAssertNil(Weight.parse("185 lb\u{017F}", lb), "a long s is not an s")
        XCTAssertNil(Weight.parse("185\u{0085}", lb), "NEL is not a space")
        XCTAssertEqual(lbOf("\u{FEFF}185", lb), 185, "a BOM is")
        XCTAssertEqual(lbOf("185\u{00A0}lb", lb), 185)
        XCTAssertEqual(Weight.leadingNumber("\u{FEFF}5"), 5)
        XCTAssertEqual(Weight.leadingNumber("5\u{0301}"), 5)
        XCTAssertNil(Weight.leadingNumber("\u{0085}5"))
    }

    func testTheProfileContext() {
        XCTAssertEqual(Weight.Context(profileUnit: "kg", bodyWeightLb: 180), kgBW)
        XCTAssertEqual(Weight.Context(profileUnit: nil, bodyWeightLb: nil), lb)
        XCTAssertEqual(Weight.Context(profileUnit: "stone", bodyWeightLb: -5), lb)
    }

    func testLeadingNumber() {
        XCTAssertEqual(Weight.leadingNumber("5"), 5)
        XCTAssertEqual(Weight.leadingNumber("8 each side"), 8)
        XCTAssertEqual(Weight.leadingNumber(" 7.5 "), 7.5)
        XCTAssertEqual(Weight.leadingNumber("12."), 12)
        XCTAssertNil(Weight.leadingNumber("x5"))
        XCTAssertNil(Weight.leadingNumber(""))
        XCTAssertNil(Weight.leadingNumber(nil))
    }

    // MARK: - The volume line (WorkoutSummary.weight.test.tsx)

    /// A warm-up 60 × 5, then a bare 100 × 5 and an explicit 100 kg × 5.
    private func benchDay() -> [TrackedSectionGroup] {
        func set(_ n: Int, _ weight: String, warmup: Bool = false) -> TrackedSet {
            TrackedSet(setNumber: n, actualWeight: weight, actualReps: "5", isLogged: true, isWarmup: warmup)
        }
        let bench = TrackedExercise(
            section: "exercise", exercise: Exercise(id: "bench", name: "Bench Press", category: "strength"),
            isCardio: false, sets: [set(1, "60", warmup: true), set(2, "100"), set(3, "100 kg")]
        )
        return [TrackedSectionGroup(section: "exercise", label: "Main Work", exercises: [bench])]
    }

    func testAKgLifterReadsBareNumbersAsKgAndWarmupsCountNothing() {
        // (100 + 100) kg × 5.
        XCTAssertEqual(Weight.sessionTonnage(benchDay(), kg), 1000)
    }

    func testAPoundsLifterStaysInPounds() {
        // 100 lb × 5 + 220.462 lb × 5 = 1602.31 → 1,602.
        XCTAssertEqual(Weight.sessionTonnage(benchDay(), lb), 1602)
    }

    func testZeroFillsPitchesCardioAndUnparseableSetsAddNothing() {
        let skipped = TrackedSet(setNumber: 1, actualWeight: "0", actualReps: "0", isAutofilled: true)
        let bodyweight = TrackedSet(setNumber: 2, actualWeight: "BW+25", actualReps: "8")
        let noReps = TrackedSet(setNumber: 3, actualWeight: "135", actualReps: "")
        let lift = TrackedExercise(
            section: "exercise", exercise: Exercise(id: "dip", name: "Dip", category: "strength"),
            isCardio: false, sets: [skipped, bodyweight, noReps]
        )
        // "5.10" parses as 5.1 lb: only the climbing exclusion keeps a grade out.
        let pitch = TrackedExercise(
            section: "exercise", exercise: Exercise(id: "p", name: "Pitch", category: "climbing"),
            isCardio: false, sets: [TrackedSet(setNumber: 1, actualWeight: "5.10", actualReps: "1")]
        )
        let run = TrackedExercise(
            section: "exercise", exercise: Exercise(id: "r", name: "Run", category: "cardio"),
            isCardio: true, sets: [TrackedSet(setNumber: 1, actualWeight: "100", actualReps: "5")]
        )
        let groups = [TrackedSectionGroup(section: "exercise", label: "Main Work", exercises: [lift, pitch, run])]
        XCTAssertEqual(Weight.sessionTonnage(groups, lbBW), 205 * 8, "BW+25 resolves; the rest add nothing")
        XCTAssertNil(Weight.sessionTonnage(groups, lb), "without a body weight nothing carried both")
    }

    func testATotalNoIntHoldsIsNoLineRatherThanACrash() {
        let absurd = TrackedExercise(
            section: "exercise", exercise: Exercise(id: "x", name: "X", category: "strength"),
            isCardio: false, sets: [TrackedSet(setNumber: 1, actualWeight: "10000000000000000000", actualReps: "1")]
        )
        XCTAssertNil(Weight.sessionTonnage([TrackedSectionGroup(section: "exercise", label: "Main Work", exercises: [absurd])], lb))
    }
}
