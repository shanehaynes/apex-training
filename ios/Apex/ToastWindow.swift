import ApexUI
import SwiftUI
import UIKit

/// Hosts `ToastHost` in its own window one level above the app's, so a toast
/// posted while a `.sheet` or `.fullScreenCover` is up renders over it instead
/// of under it (#167, D-032). The window is created once, when the app's
/// window first joins a scene (`ToastWindowAttacher` below).
@MainActor
final class ToastWindowController {
    static let shared = ToastWindowController()

    private var window: ToastWindow?

    private init() {}

    nonisolated deinit {}

    func attach(to scene: UIWindowScene) {
        guard window == nil else { return }
        let window = ToastWindow(windowScene: scene)
        let host = UIHostingController(rootView: ToastHost())
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.backgroundColor = .clear
        window.windowLevel = .normal + 1
        window.isHidden = false
        self.window = window
    }
}

/// Passes every touch through to the app's window unless it lands on a toast:
/// `ToastHost` records the banners' own bounds on the bus, and a `nil` from
/// `hitTest` makes UIKit try the next window down.
///
/// Both halves of that guard matter. With nothing showing the recorded frame
/// is whatever the last toast left behind, and `super.hitTest` on an empty
/// hosting view still answers the view rather than `nil` — the band would go
/// on swallowing taps after the toast was gone.
final class ToastWindow: UIWindow {
    nonisolated deinit {}

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let bus = ToastBus.shared
        guard !bus.toasts.isEmpty, bus.frame.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// A zero-size view whose only job is to learn which scene the app's window
/// belongs to. `connectedScenes` can be empty or not yet active on the first
/// body evaluation; `didMoveToWindow` fires exactly when the answer exists.
struct ToastWindowAttacher: UIViewRepresentable {
    func makeUIView(context: Context) -> AttachView { AttachView() }
    func updateUIView(_ uiView: AttachView, context: Context) {}

    final class AttachView: UIView {
        nonisolated deinit {}

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let scene = window?.windowScene else { return }
            ToastWindowController.shared.attach(to: scene)
        }
    }
}
