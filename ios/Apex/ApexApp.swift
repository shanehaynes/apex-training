import ApexAuth
import ApexFeatures
import ApexUI
import SwiftUI

@main
struct ApexApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        AppConfig.assertSafe()
        ApexFonts.register()
        #if DEBUG
        if CommandLine.arguments.contains("-apexMockClient") {
            _model = State(initialValue: AppModel(mock: MockEnvironment()))
            return
        }
        #endif
        let auth = AuthService(
            supabaseURL: AppConfig.supabaseURL,
            anonKey: AppConfig.supabaseAnonKey
        )
        _model = State(initialValue: AppModel(auth: auth))
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                RootView()
                ToastHost()
            }
            .environment(model)
            // Dark only (D-010) — belt and braces with UIUserInterfaceStyle,
            // which SwiftUI previews do not read.
            .preferredColorScheme(.dark)
            .onChange(of: scenePhase) { _, phase in model.scenePhase(phase) }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.state {
        case .restoring:
            // Never flash the sign-in screen at a user who is already signed in.
            ZStack {
                ApexColor.bgPrimary.ignoresSafeArea()
                ProgressView().tint(ApexColor.textMuted)
            }
        case .signedOut(let reason):
            SignInView(
                onSignIn: { email, password in
                    await model.signIn(email: email, password: password)
                },
                onForgotPassword: { email in
                    await model.sendPasswordReset(email: email)
                }
            )
            .task {
                if let reason { ToastBus.shared.post(reason, level: .failure) }
            }
        case .signedIn(_, let email):
            RootTabView(schedule: model.schedule, email: email) { model.signOut() }
        }
    }
}
