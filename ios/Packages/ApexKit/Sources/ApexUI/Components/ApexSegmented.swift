import SwiftUI

/// The web's `.view-toggle` / `.range-toggle`: an accent pill sliding on an
/// elevated track.
public struct ApexSegmented<Value: Hashable & Sendable>: View {
    private let options: [(value: Value, label: String)]
    @Binding private var selection: Value
    @Namespace private var pill

    public init(selection: Binding<Value>, options: [(value: Value, label: String)]) {
        self._selection = selection
        self.options = options
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.value) { option in
                Button {
                    withAnimation(Motion.spring) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(.apex(.display, size: TypeScale.xs, weight: .semibold, relativeTo: .caption))
                        .foregroundStyle(
                            selection == option.value ? ApexColor.bgPrimary : ApexColor.textSecondary
                        )
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background {
                            if selection == option.value {
                                Capsule()
                                    .fill(ApexColor.accent)
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(ApexColor.bgElevated, in: .capsule)
        .frame(minHeight: 44)
    }
}
