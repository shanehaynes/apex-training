import SwiftUI

/// Colours the web uses but never tokenised, so `gen-tokens.mjs` has no source
/// to read them from. They are listed in design-spec.md §1 as "promote to a
/// token" — if that ever happens on the web, move them into the generator and
/// delete them here.
public enum ApexPalette {
    /// Hover and emphasis borders (`#3d3530`).
    public static let borderStrong = Color(hex: 0x3D3530)
    /// The de-facto "done" colour: completion ticks, today headings, overflow links.
    public static let positive = Color(hex: 0xF97316)
    /// The now-line on the day view.
    public static let danger = Color(hex: 0xEF4444)
    public static let dangerText = Color(hex: 0xF87171)
    public static let destructive = Color(hex: 0xB91C1C)
    public static let userBubble = Color(hex: 0x1E3A5F)
    public static let userBubbleBorder = Color(hex: 0x2A5080)

    /// Block attainment semantics (design-spec §1).
    public enum Attainment {
        public static let met = Color(hex: 0x2EB82E)
        public static let close = Color(hex: 0xF97316)
        public static let under = ApexColor.textMuted
    }
}

/// The 4pt rhythm the web uses without naming (design-spec §3).
public enum Spacing {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 24
    public static let xxl: CGFloat = 32
    /// Standard screen inset.
    public static let screen: CGFloat = 16
}
