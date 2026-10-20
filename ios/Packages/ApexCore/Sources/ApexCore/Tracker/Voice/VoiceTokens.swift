import Foundation

/// One token of a transcript after `VoiceTokens.tokenize`: a number written in
/// digits, a clock (`2:25`, `1:05:00`) or a word. Number *words* ("two twenty
/// five") stay words; `VoiceNumbers.readNumber` reads them.
public struct VoiceToken: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case number(Double)
        /// `first:second[:third]` as spoken digits; what it means — a weight
        /// dictation wrote as a clock, or a duration — is the slot rules' call.
        case clock(first: Int, second: Int, third: Int?)
        case word
    }

    /// The token's surface, lowercased and normalised ("lbs", "225", "2:25").
    public let text: String
    public let kind: Kind

    public init(text: String, kind: Kind) {
        self.text = text
        self.kind = kind
    }

    public var isWord: Bool { if case .word = kind { return true } else { return false } }
    public var isNumber: Bool { if case .number = kind { return true } else { return false } }
    public var isClock: Bool { if case .clock = kind { return true } else { return false } }
}

/// The voice tokenizer: a manual scan, no regex, so a web port is mechanical.
/// Lowercase; `×`→` x `, `@`→` at `, `+`→` plus `, `#`→` lb `; an `x` between
/// digits splits (`5x5`, `225x5`); apostrophes deleted; hyphens → spaces; a
/// comma between digits follows `Weight`'s rule (exactly three digits after it
/// is a thousands separator, anything else a decimal point), any other comma
/// separates; split on whitespace; trailing `.!?` stripped; digits → number;
/// `d:dd` / `h:mm:ss` → clock; a unit glued to a number splits off (`225lbs`,
/// `45s`, `2m`, `100k`), and a single letter counts as a unit only when glued.
public enum VoiceTokens {
    /// Glued single-letter units, spelled out so the slot rules see the word
    /// they already know. A free-standing "s" or "m" is never a unit.
    static let gluedLetters: [Character: String] = ["s": "seconds", "m": "minutes", "k": "kg"]

    public static func tokenize(_ transcript: String) -> [VoiceToken] {
        let chars = Array(normalise(transcript))
        var pieces: [String] = []
        var current = ""
        for (i, ch) in chars.enumerated() {
            if ch.isWhitespace {
                if !current.isEmpty { pieces.append(current); current = "" }
                continue
            }
            if ch == "," {
                // "62,5" and "1,200" keep the comma inside the number; "5, 225" separates.
                let before = i > 0 ? chars[i - 1] : " "
                let after = i + 1 < chars.count ? chars[i + 1] : " "
                if isDigit(before), isDigit(after) {
                    current.append(ch)
                } else if !current.isEmpty {
                    pieces.append(current)
                    current = ""
                }
                continue
            }
            if ch == "x" || ch == "X" {
                // "5x5" → "5 x 5": only between digits, so "x" inside a word stays.
                let before = i > 0 ? chars[i - 1] : " "
                let after = i + 1 < chars.count ? chars[i + 1] : " "
                if isDigit(before), isDigit(after) {
                    if !current.isEmpty { pieces.append(current); current = "" }
                    pieces.append("x")
                    continue
                }
            }
            current.append(ch)
        }
        if !current.isEmpty { pieces.append(current) }

        var tokens: [VoiceToken] = []
        for piece in pieces {
            var text = piece
            while let last = text.last, last == "." || last == "!" || last == "?" { text.removeLast() }
            guard !text.isEmpty else { continue }
            tokens.append(contentsOf: classify(text))
        }
        return tokens
    }

    /// Lowercase, the symbol substitutions, apostrophes gone, hyphens to spaces.
    static func normalise(_ transcript: String) -> String {
        var out = ""
        for ch in transcript.lowercased() {
            switch ch {
            case "×": out += " x "
            case "@": out += " at "
            case "+": out += " plus "
            case "#": out += " lb "
            case "'", "’", "‘": break
            case "-", "–", "—", "‐": out += " "
            default: out.append(ch)
            }
        }
        return out
    }

    private static func isDigit(_ ch: Character) -> Bool { ch.isASCII && ch.isNumber }

    /// A piece into one token — or two when a unit is glued to a number.
    static func classify(_ text: String) -> [VoiceToken] {
        if let clock = clock(text) { return [VoiceToken(text: text, kind: clock)] }
        let digits = text.prefix { isDigit($0) || $0 == "." || $0 == "," }
        let rest = text.dropFirst(digits.count)
        if !digits.isEmpty, digits.contains(where: isDigit), let value = number(String(digits)) {
            let numberToken = VoiceToken(text: String(digits), kind: .number(value))
            if rest.isEmpty { return [numberToken] }
            guard rest.allSatisfy(\.isLetter) else { return [VoiceToken(text: text, kind: .word)] }
            if rest.count == 1, let unit = gluedLetters[rest.first!] {
                return [numberToken, VoiceToken(text: unit, kind: .word)]
            }
            return [numberToken, VoiceToken(text: String(rest), kind: .word)]
        }
        return [VoiceToken(text: text, kind: .word)]
    }

    /// No lifter says a number of more than this many whole digits; past it a
    /// digit string is a word, so no later arithmetic can overflow.
    static let maxWholeDigits = 9
    /// The first part of a clock, likewise.
    static let maxClockDigits = 4

    /// `Weight`'s comma rule, then a plain decimal.
    static func number(_ text: String) -> Double? {
        let parts = text.split(separator: ",", omittingEmptySubsequences: false)
        if parts.count == 2, parts[1].count == 3, parts[1].allSatisfy(isDigit) {
            guard parts[0].count + 3 <= maxWholeDigits else { return nil }
            return Double(parts.joined())
        }
        let decimal = text.replacingOccurrences(of: ",", with: ".")
        guard decimal.filter({ $0 == "." }).count <= 1, decimal.first != ".", decimal.last != ".",
              decimal.prefix(while: isDigit).count <= maxWholeDigits else { return nil }
        return Double(decimal)
    }

    /// `d:dd`, `dd:dd` or `h:mm:ss` — every part digits, the later ones one or two of them.
    static func clock(_ text: String) -> VoiceToken.Kind? {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 || parts.count == 3,
              parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(isDigit) }),
              parts[0].count <= maxClockDigits,
              parts.dropFirst().allSatisfy({ $0.count <= 2 }),
              let first = Int(parts[0]), let second = Int(parts[1]) else { return nil }
        let third = parts.count == 3 ? Int(parts[2]) : nil
        if parts.count == 3, third == nil { return nil }
        return .clock(first: first, second: second, third: third)
    }
}
