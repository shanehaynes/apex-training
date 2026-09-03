import SwiftUI

extension Color {
    /// `Color(hex: 0x0D0C0B)`. The generated tokens are written this way so a
    /// hex from the web's CSS lands in Swift unchanged and greppable.
    public init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
