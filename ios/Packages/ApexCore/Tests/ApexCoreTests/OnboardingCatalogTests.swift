import XCTest
@testable import ApexCore

/// The generated onboarding copy (W13, D-035): shape and the contract the
/// screens switch over. The words themselves are the web's; `ci:guards`
/// fails when this file and content.ts drift.
final class OnboardingCatalogTests: XCTestCase {
    /// Four cards, then silence (D-O05): everything else is a tip.
    func testTheWelcomeFlowIsTheWebsFourStepsInOrder() {
        XCTAssertEqual(OnboardingCatalog.welcomeSteps.map(\.id), ["welcome", "plan", "log", "coach"])
        XCTAssertEqual(OnboardingCatalog.welcomeSteps.first?.title, "Welcome to Apex")
        XCTAssertTrue(OnboardingCatalog.welcomeSteps.allSatisfy { !$0.requiresCoros }, "no step waits on a watch provider")
        let coach = OnboardingCatalog.welcomeSteps.last
        XCTAssertEqual(coach?.action, OnboardingCatalog.Action(label: "Add key", kind: .openProfile))
        XCTAssertEqual(coach?.link?.href, "/help/get-api-key")
        XCTAssertEqual(OnboardingCatalog.guideURL, "/help")
    }

    /// Every link the flow carries is Apex-hosted: relative, resolved against
    /// the web origin by the app.
    func testEveryStepLinkIsApexHosted() {
        for step in OnboardingCatalog.welcomeSteps {
            guard let href = step.link?.href else { continue }
            XCTAssertTrue(href.hasPrefix("/help"), step.id)
        }
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

    /// The copy rules: 35 words or fewer, so a card gets finished.
    func testBodiesStayShort() {
        for step in OnboardingCatalog.welcomeSteps {
            XCTAssertLessThanOrEqual(step.body.split(separator: " ").count, 35, step.id)
        }
        XCTAssertEqual(OnboardingCatalog.extraNotes.count, 2)
    }
}
