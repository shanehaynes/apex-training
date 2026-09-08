import SwiftUI

/// The lucide → SF Symbols map from design-spec §6, grown one workstream at a
/// time. Kept in one place so an icon means the same thing on every screen and
/// a rename happens once. `ApexTests` asserts every case resolves.
public enum ApexIcon: String, CaseIterable, Sendable {
    case calendar = "calendar"
    case checkCircle = "checkmark.circle.fill"
    case circle = "circle"
    case play = "play.fill"
    case chevronLeft = "chevron.left"
    case chevronRight = "chevron.right"
    case clock = "clock"
    case mapPin = "mappin.and.ellipse"
    case route = "point.topleft.down.to.point.bottomright.curvepath"
    case trendingUp = "chart.line.uptrend.xyaxis"
    case heartPulse = "heart"
    case mountain = "mountain.2"
    case layers = "square.3.layers.3d"
    case flame = "flame"
    case watch = "applewatch"
    case utensils = "fork.knife"
    case refresh = "arrow.clockwise"
    case offline = "wifi.slash"
    case dumbbell = "dumbbell"
    case sparkles = "sparkles"
    case person = "person"
    case plus = "plus"
    // W4 — the tracker.
    case flag = "flag.fill"
    case trophy = "trophy"
    case swap = "arrow.2.squarepath"
    case close = "xmark"
    case trash = "trash"
    case pendingSync = "arrow.triangle.2.circlepath"
    case warning = "exclamationmark.triangle"
    case ghost = "wand.and.stars"
    // W6 — the coach.
    case send = "arrow.up.circle.fill"
    case stop = "stop.fill"
    case notes = "text.book.closed"
    case history = "clock.arrow.circlepath"
    case newChat = "square.and.pencil"
    case key = "key"
    case check = "checkmark"
    case chat = "bubble.left.and.bubble.right"

    /// Light weight, like the web's 1.5px lucide strokes.
    public var image: some View {
        Image(systemName: rawValue).fontWeight(.light)
    }

    /// For `Label(_:systemImage:)` and other string-taking APIs.
    public var systemName: String { rawValue }
}
