import SwiftUI

/// The house empty state: eyebrow, one muted line, nothing else.
public struct EmptyState: View {
    private let eyebrow: String
    private let message: String
    private let symbol: String

    public init(eyebrow: String, message: String, symbol: String) {
        self.eyebrow = eyebrow
        self.message = message
        self.symbol = symbol
    }

    public var body: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: symbol)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(ApexColor.textMuted)
            Text(eyebrow).apexEyebrow()
            Text(message)
                .apexBody()
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ApexColor.bgPrimary)
    }
}
