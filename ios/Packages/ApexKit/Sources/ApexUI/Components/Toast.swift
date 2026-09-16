import SwiftUI

public struct Toast: Identifiable, Equatable, Sendable {
    public enum Level: Sendable { case info, success, failure }

    public let id = UUID()
    public let message: String
    public let level: Level

    public init(_ message: String, level: Level = .info) {
        self.message = message
        self.level = level
    }
}

/// A module-level bus so non-view code can post — the analogue of
/// `src/lib/notify.ts`, which the whole web app calls without threading a
/// handler through every component.
@MainActor
@Observable
public final class ToastBus {
    public static let shared = ToastBus()

    public private(set) var toasts: [Toast] = []

    /// Where the stack is drawn, in the hosting window's coordinates (the
    /// window fills the screen, so SwiftUI's global space is its space). The
    /// overlay window (`ToastWindow` in the app target) passes every touch
    /// outside it through to the app. Zero-sized while nothing is showing.
    public var frame: CGRect = .null

    private init() {}

    // Under MainActor default isolation the deinit would be synthesized as
    // *isolated*, which routes deallocation through swift_task_deinitOnExecutor
    // and aborts on the iOS 17/18 runtime when the object dies outside a task
    // (swiftlang/swift#87316, D-031). Nothing here needs the actor to die.
    nonisolated deinit {}

    public func post(_ toast: Toast) {
        toasts.append(toast)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.dismiss(toast.id)
        }
    }

    public func post(_ message: String, level: Toast.Level = .info) {
        post(Toast(message, level: level))
    }

    public func dismiss(_ id: UUID) {
        toasts.removeAll { $0.id == id }
    }
}

/// Renders the bus. The app target hosts it in its own passthrough
/// `UIWindow` above the main one, so toasts float over every sheet and
/// `fullScreenCover` (D-032) instead of under them.
public struct ToastHost: View {
    @State private var bus = ToastBus.shared

    public init() {}

    public var body: some View {
        VStack(spacing: Spacing.sm) {
            ForEach(bus.toasts) { toast in
                Text(toast.message)
                    .font(.apex(.display, size: TypeScale.sm, weight: .medium, relativeTo: .body))
                    .foregroundStyle(ApexColor.textPrimary)
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.md)
                    .background(ApexColor.bgElevated, in: .rect(cornerRadius: Radius.lg))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.lg)
                            .strokeBorder(border(toast.level), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.6), radius: 12, y: 4)
                    .onTapGesture { bus.dismiss(toast.id) }
                    .accessibilityIdentifier("toast.\(toast.level)")
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, Spacing.screen)
        .animation(Motion.spring, value: bus.toasts)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { bus.frame = $0 }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(!bus.toasts.isEmpty)
    }

    private func border(_ level: Toast.Level) -> Color {
        switch level {
        case .info: ApexColor.borderSubtle
        case .success: ApexPalette.positive
        case .failure: ApexPalette.dangerText
        }
    }
}
