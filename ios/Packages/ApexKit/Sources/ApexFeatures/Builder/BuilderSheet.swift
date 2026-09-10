import ApexCore
import ApexUI
import SwiftUI

/// The workout builder's sheet. This PR wires the entry points (the "+",
/// "Edit workout"); the template search, form and coach drawer land in the
/// next one over this same route.
public struct BuilderSheet: View {
    let model: ScheduleModel
    let route: BuilderRoute
    let onClose: () -> Void

    public var body: some View {
        VStack(spacing: Spacing.md) {
            SheetHeader(title: title, onClose: onClose)
            EmptyState(eyebrow: "Builder", message: "The workout builder arrives in the next update.", symbol: ApexIcon.calendarPlus.systemName)
            Spacer()
        }
        .background(ApexColor.bgSurface)
        .accessibilityIdentifier("builder")
    }

    private var title: String {
        switch route {
        case .create: "Add Workout"
        case .edit: "Edit Workout"
        }
    }
}
