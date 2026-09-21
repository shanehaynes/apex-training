import SnapshotTesting
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

    /// The coach's text is model output. A link in it keeps its words and loses
    /// its destination, so no message can send anyone to Safari on one tap.
    @MainActor
    func testCoachMarkdownKeepsLinkTextAndDropsTheDestination() {
        let attributed = MarkdownText.attributed("Read [the protocol](https://example.com/x) before Friday.")
        XCTAssertEqual(String(attributed.characters), "Read the protocol before Friday.")
        XCTAssertTrue(attributed.runs.allSatisfy { $0.link == nil }, "a link survived the strip")

        // A bare URL is text either way, and the other inline styles are untouched.
        let styled = MarkdownText.attributed("**Heavy** day — see https://example.com")
        XCTAssertEqual(String(styled.characters), "Heavy day — see https://example.com")
        XCTAssertTrue(styled.runs.allSatisfy { $0.link == nil })
        XCTAssertTrue(styled.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }

    // MARK: - The picker primitives (ux-review §1.3)

    private static let types: [(value: String, label: String)] = [
        ("weights", "Strength"), ("cardio", "Cardio"), ("climbing", "Climbing"),
        ("yoga", "Yoga"), ("stretching", "Stretching"), ("morning-routine", "Morning Routine"),
        ("outdoor-climbing", "Outdoor Climbing"),
    ]

    private static let measures: [PickerGroup<String>] = [
        PickerGroup("Volume", options: [("sets", "Sets"), ("reps", "Reps"), ("tonnage", "Tonnage")]),
        PickerGroup("Time", options: [("duration", "Duration"), ("moving-time", "Moving Time")]),
        PickerGroup("Heart", options: [("avg-hr", "Avg Heart Rate"), ("max-hr", "Max Heart Rate")]),
    ]

    /// The row reads the bound value's words, and an id with no option shows the
    /// placeholder rather than an empty row.
    @MainActor
    func testMenuPickerResolvesTheCurrentLabel() {
        let picker = MenuPicker("Type", options: Self.types, selection: .constant("climbing"))
        XCTAssertEqual(picker.currentLabel, "Climbing")

        let unknown = MenuPicker("Type", options: Self.types, selection: .constant("surfing"), placeholder: "Choose")
        XCTAssertEqual(unknown.currentLabel, "Choose")
    }

    /// The `Identifiable` form binds the item's id and labels by key path.
    @MainActor
    func testMenuPickerTakesAnIdentifiableArray() {
        struct Exercise: Identifiable { let id: String; let name: String }
        let picker = MenuPicker(
            "Exercise",
            items: [Exercise(id: "a", name: "Back Squat"), Exercise(id: "b", name: "Front Squat")],
            labelKey: \.name, selection: .constant("b")
        )
        XCTAssertEqual(picker.currentLabel, "Front Squat")
    }

    /// `collapseAbove` is a strict ceiling: equal to it is still chips, one more
    /// is the menu — and the default keeps every existing row exactly as it was.
    @MainActor
    func testCollapseAboveSwitchesRepresentationAtTheBoundary() {
        let four = Array(Self.types.prefix(4))
        let five = Array(Self.types.prefix(5))

        XCTAssertFalse(ChipRow("Type", options: four, selection: .constant("weights"), collapseAbove: 4).isCollapsed)
        XCTAssertTrue(ChipRow("Type", options: five, selection: .constant("weights"), collapseAbove: 4).isCollapsed)
        XCTAssertFalse(ChipRow("Type", options: Self.types, selection: .constant("weights")).isCollapsed)
        // A ceiling of 0 collapses anything non-empty; an empty row never does.
        XCTAssertTrue(ChipRow("Type", options: four, selection: .constant("weights"), collapseAbove: 0).isCollapsed)
        XCTAssertFalse(ChipRow("Type", options: [], selection: .constant("weights"), collapseAbove: 0).isCollapsed)
    }

    /// An empty query is every group untouched; a query is a case-insensitive
    /// substring over the labels, groups kept in the order they were given and
    /// emptied groups dropped.
    @MainActor
    func testSearchablePickerSheetFiltersCaseInsensitivelyAndKeepsGroupOrder() {
        typealias Sheet = SearchablePickerSheet<String>

        XCTAssertEqual(Sheet.filter(Self.measures, query: "").map(\.title), ["Volume", "Time", "Heart"])
        XCTAssertEqual(Sheet.filter(Self.measures, query: "   ").map(\.title), ["Volume", "Time", "Heart"])

        // "T" hits Tonnage, both Time rows and Heart Rate — every group, in order.
        let t = Sheet.filter(Self.measures, query: "t")
        XCTAssertEqual(t.map(\.title), ["Volume", "Time", "Heart"])
        XCTAssertEqual(t[0].options.map(\.label), ["Sets", "Tonnage"])

        // Case does not matter, and neither does the case of the option.
        let hr = Sheet.filter(Self.measures, query: "HEART")
        XCTAssertEqual(hr.map(\.title), ["Heart"])
        XCTAssertEqual(hr[0].options.map(\.label), ["Avg Heart Rate", "Max Heart Rate"])
        XCTAssertEqual(Sheet.filter(Self.measures, query: "heart").map(\.title), ["Heart"])

        // Option order inside a group survives the filter.
        XCTAssertEqual(Sheet.filter(Self.measures, query: "s")[0].options.map(\.label), ["Sets", "Reps"])

        XCTAssertTrue(Sheet.filter(Self.measures, query: "zzz").isEmpty)
    }

    // MARK: - Snapshots (opt-in, like the feature suites)

    @MainActor
    private func snapshot(_ view: some View, named name: String, size: CGSize) throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["APEX_SNAPSHOTS"] == "1", "set APEX_SNAPSHOTS=1 to run snapshot tests")
        ApexFonts.register()
        let framed = view
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(ApexColor.bgPrimary)
            .preferredColorScheme(.dark)
        assertSnapshot(of: framed, as: .image(layout: .fixed(width: size.width, height: size.height)), named: name)
    }

    /// The menu picker's closed row, in the same field box as a `FormField`
    /// above it, so a drift in one shows against the other.
    @MainActor
    func testMenuPickerRow() throws {
        try snapshot(
            VStack(alignment: .leading, spacing: Spacing.lg) {
                FormField("Title", text: .constant("Wednesday Intervals"), placeholder: "Name it")
                MenuPicker("Type", options: Self.types, selection: .constant("climbing"))
                MenuPicker("Sport", options: [(value: "run", label: "Run")], selection: .constant("bike"), placeholder: "Choose")
            }
            .padding(Spacing.screen),
            named: "menu-picker", size: CGSize(width: 393, height: 260)
        )
    }

    /// The same row, chips and collapsed, one above the other: the point of the
    /// whole package is that these are the same control.
    @MainActor
    func testChipRowCollapseAbove() throws {
        try snapshot(
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ChipRow("Type — chips", options: Self.types, selection: .constant("weights"))
                ChipRow("Type — collapsed", options: Self.types, selection: .constant("weights"), collapseAbove: 4)
            }
            .padding(Spacing.screen),
            named: "chip-row-collapse", size: CGSize(width: 393, height: 300)
        )
    }

    @MainActor
    func testSearchablePickerSheetContent() throws {
        try snapshot(
            SearchablePickerSheet(title: "Measure", groups: Self.measures, selection: "duration") { _ in },
            named: "searchable-picker-sheet", size: CGSize(width: 393, height: 560)
        )
    }
}
