import CoreText
import SwiftUI

public enum ApexFont {
    case display   // Inter
    case mono      // JetBrains Mono
    case wordmark  // Barlow Condensed
}

extension Font {
    /// House type. `relativeTo` keeps Dynamic Type working — the sizes in
    /// `TypeScale` are base sizes, not fixed ones.
    public static func apex(
        _ face: ApexFont,
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo style: Font.TextStyle = .body
    ) -> Font {
        .custom(ApexFonts.name(for: face, weight: weight), size: size, relativeTo: style)
    }
}

public enum ApexFonts {
    /// Registers the bundled faces.
    ///
    /// `UIAppFonts` cannot do this: it only registers fonts in the *main app
    /// bundle*, and SwiftPM resources land in `ApexKit_ApexUI.bundle`. Runtime
    /// registration also means SwiftUI previews and the snapshot test bundle get
    /// the real faces, which `UIAppFonts` would not give them. Called once from
    /// the app's `init`; idempotent, because previews call it too.
    public static func register() {
        guard !hasRegistered else { return }
        hasRegistered = true
        for file in files {
            guard let url = Bundle.module.url(forResource: file, withExtension: "ttf") else {
                assertionFailure("missing bundled font \(file).ttf")
                continue
            }
            var error: Unmanaged<CFError>?
            // .process scope: the faces are ours, not the system's.
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                // Already registered is not a failure — previews re-enter this.
                let code = error?.takeUnretainedValue().localizedDescription ?? "unknown"
                assert(code.contains("already"), "could not register \(file): \(code)")
            }
        }
    }

    static func name(for face: ApexFont, weight: Font.Weight) -> String {
        switch face {
        case .wordmark:
            return "BarlowCondensed-Bold"
        case .mono:
            return weight >= .medium ? "JetBrainsMono-Medium" : "JetBrainsMono-Regular"
        case .display:
            switch weight {
            case .bold, .heavy, .black: return "Inter-Bold"
            case .semibold: return "Inter-SemiBold"
            case .medium: return "Inter-Medium"
            default: return "Inter-Regular"
            }
        }
    }

    /// Every face that must exist in Resources/Fonts. ApexTests asserts each one
    /// resolves, because a missing TTF otherwise degrades silently to San Francisco.
    public static let files = [
        "Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold",
        "JetBrainsMono-Regular", "JetBrainsMono-Medium",
        "BarlowCondensed-Bold",
    ]

    public static let postScriptNames = files

    private nonisolated(unsafe) static var hasRegistered = false
}

private extension Font.Weight {
    static func >= (lhs: Font.Weight, rhs: Font.Weight) -> Bool {
        order(lhs) >= order(rhs)
    }

    static func order(_ weight: Font.Weight) -> Int {
        switch weight {
        case .ultraLight: 0
        case .thin: 1
        case .light: 2
        case .regular: 3
        case .medium: 4
        case .semibold: 5
        case .bold: 6
        case .heavy: 7
        case .black: 8
        default: 3
        }
    }
}
