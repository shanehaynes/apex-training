import ApexCore
import ApexUI
import SwiftUI

/// Threshold and max HR: numeric keyboards, both saved in one write when the
/// form loses focus or submits. Blank clears a zone; out-of-range values are
/// refused here with the web's wording rather than as a server 400.
public struct HeartRateZonesView: View {
    private let model: YouModel
    @State private var threshold: String
    @State private var max: String
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case threshold, max }

    public init(model: YouModel) {
        self.model = model
        _threshold = State(initialValue: model.profile?.thresholdHr.map(String.init) ?? "")
        _max = State(initialValue: model.profile?.maxHr.map(String.init) ?? "")
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Hint("Zone charts in Analytics use Friel LTHR bands when a threshold HR is set, %-of-max bands otherwise. Blank a field to clear it.")
                HStack(alignment: .top, spacing: Spacing.md) {
                    FormField("Threshold HR (LTHR)", text: $threshold, placeholder: "e.g. 165", keyboard: .numberPad, identifier: "you.hr.threshold")
                        .focused($focus, equals: .threshold)
                    FormField("Max HR", text: $max, placeholder: "e.g. 188", keyboard: .numberPad, identifier: "you.hr.max")
                        .focused($focus, equals: .max)
                }
                if let error { InlineError(error) }
                ApexButton("Save", kind: .secondary) { focus = nil; Task { await save() } }
                    .accessibilityIdentifier("you.hr.save")
            }
            .padding(Spacing.screen)
        }
        .youScreen("Heart-rate zones")
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focus = nil }
                    .font(.apex(.display, size: TypeScale.sm, weight: .semibold, relativeTo: .body))
            }
        }
        .onChange(of: focus) { _, field in
            if field == nil { Task { await save() } }
        }
    }

    private func save() async {
        error = await model.saveHeartRate(maxHr: max, thresholdHr: threshold)
    }
}
