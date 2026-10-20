import ApexUI
import SwiftUI
import WebKit

/// The human check for Create account (docs/specs/open-signup.md M3).
/// Turnstile only runs in a web page on a hostname its widget allows, so this
/// shows the web app's `/signup-check` page (src/components/auth/SignupCheckPage.tsx)
/// and takes the token it posts over the `turnstile` message handler. The page
/// talks to nothing but Cloudflare; the app sends the token to /api/signup.
struct TurnstileCheckView: View {
    let url: URL
    let onToken: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TurnstileWebView(url: url) { token in
                onToken(token)
                dismiss()
            }
            .background(ApexColor.bgPrimary)
            .navigationTitle("Quick check")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("signup.check")
    }
}

private struct TurnstileWebView: UIViewRepresentable {
    let url: URL
    let onToken: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onToken: onToken) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // A fresh, non-persistent store: the check page needs no cookies from
        // anything else, and leaves none behind.
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "turnstile")
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "turnstile")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onToken: (String) -> Void
        init(onToken: @escaping (String) -> Void) { self.onToken = onToken }
        // D-031: a MainActor-default class must not deallocate on the main
        // actor's executor on the iOS 17/18 runtime.
        nonisolated deinit {}

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the page this sheet loaded may hand over a token.
            guard message.frameInfo.isMainFrame,
                  let body = message.body as? String,
                  let data = body.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["token"] as? String, !token.isEmpty
            else { return }
            onToken(token)
        }
    }
}
