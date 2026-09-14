import SwiftUI

/// Two panes stacked, the bottom one (a coach drawer) taking a fixed share —
/// the builder sheets' form-over-coach layout (W7, W9).
public struct VSplit<Top: View, Bottom: View>: View {
    private let topShare: CGFloat
    @ViewBuilder private let top: () -> Top
    @ViewBuilder private let bottom: () -> Bottom

    public init(topShare: CGFloat = 0.5, @ViewBuilder top: @escaping () -> Top, @ViewBuilder bottom: @escaping () -> Bottom) {
        self.topShare = topShare
        self.top = top
        self.bottom = bottom
    }

    public var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                top().frame(height: geometry.size.height * topShare)
                Rectangle().fill(ApexColor.borderSubtle).frame(height: 1)
                bottom().frame(maxHeight: .infinity)
            }
        }
    }
}
