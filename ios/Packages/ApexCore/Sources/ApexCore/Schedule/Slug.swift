import Foundation

/// `slugifyName` from `src/lib/schedule/definitions.ts`: the id a new library
/// definition gets from the picker's inline create, e.g. "90/90 Hip Stretch"
/// → "90-90-hip-stretch". The server requires the id in the body, so the
/// phone mints it the same way the web does.
public enum Slug {
    public static func name(_ raw: String) -> String {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
            .lowercased()
        var out = ""
        var pendingDash = false
        for scalar in normalized.unicodeScalars {
            let isAllowed = (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9")
            if isAllowed {
                if pendingDash, !out.isEmpty { out.append("-") }
                pendingDash = false
                out.unicodeScalars.append(scalar)
            } else {
                pendingDash = true
            }
        }
        return out
    }
}
