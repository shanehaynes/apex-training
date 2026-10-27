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
    /// See `SignUpOptions.presetToken`: set only by mock builds.
    var presetToken: String? = nil
    var presetTokenDelay: Duration = .milliseconds(300)
    let onToken: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    /// Cancel is final: a token Turnstile produces while the sheet animates
    /// away must not submit a sign-up the user just backed out of. Swiping the
    /// sheet down is turned off for the same reason — it has no moment to
    /// close the latch before the animation ends — so Cancel is the only way out.
    @State private var latch = Latch()
    @State private var failed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let presetToken {
                    Color.clear.task {
                        // Let the sheet finish presenting before it dismisses itself.
                        // Cancellation does not skip delivery, on purpose: the latch
                        // is what stops it, as it is for a real token mid-dismissal,
                        // so the smoke's Cancel step proves the latch.
                        try? await Task.sleep(for: presetTokenDelay)
                        deliver(presetToken)
                    }
                } else {
                    TurnstileWebView(url: url, onFailure: { failed = true }, onToken: deliver)
                }
                // Below the page, not over it: Turnstile may retry on its own,
                // and a token that arrives after a failure still goes through.
                if failed {
                    Text("Couldn't load the check. Check your connection, then Cancel and try again.")
                        .apexBody()
                        .multilineTextAlignment(.center)
                        .padding(Spacing.xl)
                        .accessibilityIdentifier("signup.check.failed")
                }
            }
            .background(ApexColor.bgPrimary)
            .navigationTitle("Quick check")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        latch.open = false
                        dismiss()
                    }
                }
            }
        }
        .interactiveDismissDisabled()
        .accessibilityIdentifier("signup.check")
    }

    private func deliver(_ token: String) {
        guard latch.open else { return }
        latch.open = false
        onToken(token)
        dismiss()
    }
}

/// A reference, so the web view's callback and the Cancel button read the
/// same flag without waiting for a SwiftUI state update.
private final class Latch {
    var open = true
    nonisolated deinit {}
}

private struct TurnstileWebView: UIViewRepresentable {
    let url: URL
    let onFailure: () -> Void
    let onToken: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(origin: url, onFailure: onFailure, onToken: onToken) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // A fresh, non-persistent store: the check page needs no cookies from
        // anything else, and leaves none behind.
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "turnstile")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "turnstile")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let origin: URL
        let onFailure: () -> Void
        let onToken: (String) -> Void
        init(origin: URL, onFailure: @escaping () -> Void, onToken: @escaping (String) -> Void) {
            self.origin = origin
            self.onFailure = onFailure
            self.onToken = onToken
        }
        // D-031: a MainActor-default class must not deallocate on the main
        // actor's executor on the iOS 17/18 runtime.
        nonisolated deinit {}

        private func isCheckPage(host: String?, scheme: String?, port: Int?) -> Bool {
            host == origin.host && scheme == origin.scheme && (port ?? 0) == (origin.port ?? 0)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the page this sheet loaded may hand over a token.
            let from = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  isCheckPage(host: from.host, scheme: from.protocol, port: from.port == 0 ? nil : from.port),
                  let body = message.body as? String,
                  let data = body.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            if let token = json["token"] as? String, !token.isEmpty {
                onToken(token)
            } else if json["expired"] as? Bool == true {
                // The widget's script failed to load, it errored, or a token
                // lapsed: whichever, no token is coming while the sheet is up.
                onFailure()
            }
        }

        // The main frame stays on the check page; Cloudflare's widget runs in
        // its own subframe, which this does not restrict.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            guard action.targetFrame?.isMainFrame ?? true else { return decisionHandler(.allow) }
            let target = action.request.url
            decisionHandler(isCheckPage(host: target?.host, scheme: target?.scheme, port: target?.port) ? .allow : .cancel)
        }

        // A missing or broken check page is a failure too, not a blank sheet.
        // Other 4xx render: a firewall challenge (403/429) is a page that
        // resolves itself and reloads the check.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor response: WKNavigationResponse,
            decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
        ) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse,
               http.statusCode == 404 || http.statusCode >= 500 {
                onFailure()
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onFailure()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onFailure()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onFailure()
        }
    }
}
