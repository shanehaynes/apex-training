import SwiftUI

/// The semantic signals, by the name every call site already uses. The values
/// are no longer here: design-spec §1's "promote to a token" rows were promoted
/// to `src/styles/tokens.css`, so `gen-tokens.mjs` emits them as `ApexSignal`
/// and one palette serves both clients. This enum is the stable call-site name.
public enum ApexPalette {
    /// Hover and emphasis borders.
    public static let borderStrong = ApexSignal.borderStrong
    /// The de-facto "done" colour: completion ticks, today headings, overflow links.
    public static let positive = ApexSignal.positive
    /// The now-line on the day view.
    public static let danger = ApexSignal.danger
    public static let dangerText = ApexSignal.dangerText
    public static let destructive = ApexSignal.destructive
    /// The user's chat bubble: `bgElevated` and a hairline — their own words
    /// need no colour of their own.
    public static let userBubble = ApexSignal.userBubble
    public static let userBubbleBorder = ApexSignal.userBubbleBorder
    /// The one mark colour of the synced-activity stream charts
    /// (`StreamCharts.tsx`) — the app's single signal, which clears 3:1 on the
    /// sheet with room to spare.
    public static let streamMark = ApexSignal.streamMark

    /// Block attainment semantics (design-spec §1).
    public enum Attainment {
        public static let met = ApexSignal.attainmentMet
        public static let close = ApexSignal.attainmentClose
        public static let under = ApexSignal.attainmentUnder
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

extension WorkoutTypeTokens {
    /// The palette for a raw `workout_type`, with a neutral fallback for a type
    /// this build does not know — a new server-side type renders rather than
    /// crashes (the web's `getWorkoutColor` is total over its enum; this is not).
    public static func palette(for rawType: String) -> WorkoutPalette {
        byRawValue[rawType] ?? WorkoutPalette(
            label: rawType.replacingOccurrences(of: "-", with: " ").capitalized,
            solid: ApexColor.bgElevated,
            border: ApexColor.borderSubtle,
            fill: ApexColor.bgElevated,
            glow: .clear,
            glowRadius: 0
        )
    }
}
