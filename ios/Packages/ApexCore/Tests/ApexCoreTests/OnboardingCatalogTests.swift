import XCTest
@testable import ApexCore

/// The generated onboarding copy (W13, D-035): shape and the contract the
/// screens switch over. The words themselves are the web's; `ci:guards`
/// fails when this file and content.ts drift.
final class OnboardingCatalogTests: XCTestCase {
    func testTheWelcomeFlowIsTheWebsEightStepsInOrder() {
        XCTAssertEqual(
            OnboardingCatalog.welcomeSteps.map(\.id),
            ["welcome", "calendar", "tracker", "coach", "structure", "coros", "connectors", "more"]
        )
        XCTAssertEqual(OnboardingCatalog.welcomeSteps.first?.title, "Welcome to Apex")
        XCTAssertEqual(OnboardingCatalog.welcomeSteps.filter(\.requiresCoros).map(\.id), ["coros"])
        XCTAssertEqual(OnboardingCatalog.welcomeSteps.last?.link?.href, OnboardingCatalog.guideURL)
    }

    func testEveryChecklistIdHasARowAndTheNudgeIsASubset() {
        XCTAssertEqual(OnboardingCatalog.checklistItems.map(\.id), OnboardingCatalog.ChecklistID.allCases)
        for id in OnboardingCatalog.nudgeIDs {
            XCTAssertNotNil(OnboardingCatalog.checklistItem(id))
        }
        XCTAssertEqual(OnboardingCatalog.checklistItems.filter(\.requiresCoros).map(\.id), [.coros])
        XCTAssertEqual(OnboardingCatalog.checklistItem(.key)?.action.kind, .openProfile)
        XCTAssertEqual(OnboardingCatalog.checklistItem(.template)?.action.kind, .copyTemplate)
        XCTAssertEqual(OnboardingCatalog.checklistItem(.coros)?.action.kind, .connectCoros)
    }

    /// The brief: bodies under ~35 words, so a card gets finished.
    func testBodiesStayShort() {
        for step in OnboardingCatalog.welcomeSteps {
            XCTAssertLessThanOrEqual(step.body.split(separator: " ").count, 40, step.id)
        }
        XCTAssertEqual(OnboardingCatalog.extraNotes.count, 2)
    }
}
