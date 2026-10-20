import Foundation

/// Numbers and durations out of tokens — digits, number words, gym shorthand,
/// fractions, clocks — with every table a literal. Homophones (`for`, `to`,
/// `too`, `won`, `ate`) are simply absent from the tables: they are settled by
/// alternative ranking, never guessed, and digits never merge with neighbours.
public enum VoiceNumbers {
    /// A number read from `length` tokens starting where it was asked for.
    public struct Reading: Equatable, Sendable {
        public let value: Double
        public let isInteger: Bool
        public let length: Int
    }

    static let units: [String: Int] = [
        "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    ]
    static let teens: [String: Int] = [
        "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
        "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    ]
    static let tens: [String: Int] = [
        "twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50,
        "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    ]
    static let articles: Set<String> = ["a", "an"]
    static let minuteWords: Set<String> = ["minute", "minutes", "min", "mins"]
    static let secondWords: Set<String> = ["second", "seconds", "sec", "secs"]
    /// Words that end a trailing seconds count after "a minute …" — the
    /// number belongs to them, not to the duration.
    static let claimingWords: Set<String> = [
        "rep", "reps", "set", "sets", "rpe", "at", "for", "x", "by", "times", "of", "plus", "minus",
        "lb", "lbs", "pound", "pounds", "kg", "kgs", "kilo", "kilos", "kilogram", "kilograms",
        "minute", "minutes", "min", "mins",
    ]

    /// Every word the number reader knows, for the tokenizer's keyword set.
    static let numberWords: Set<String> = Set(units.keys).union(teens.keys).union(tens.keys)
        .union(["hundred", "thousand", "point", "half", "quarter"]).union(articles)

    /// Whether a token can begin a number or a duration.
    static func startsNumber(_ token: VoiceToken) -> Bool {
        switch token.kind {
        case .number, .clock: return true
        case .word:
            return units[token.text] != nil || teens[token.text] != nil || tens[token.text] != nil
                || token.text == "hundred" || token.text == "thousand" || articles.contains(token.text) || token.text == "half"
        }
    }

    private static func word(_ tokens: [VoiceToken], _ i: Int) -> String? {
        i >= 0 && i < tokens.count && tokens[i].isWord ? tokens[i].text : nil
    }

    /// The number starting at `index`: a digit token, a `d:dd` clock when
    /// `clockAsNumber` (dictation writes "two twenty five" as `2:25`; d 1–9,
    /// dd < 60 → d×100+dd), or number words — followed by an optional
    /// fraction: `point …`, `and a half`, `and a quarter`.
    public static func readNumber(_ tokens: [VoiceToken], at index: Int, clockAsNumber: Bool) -> Reading? {
        guard index < tokens.count else { return nil }
        var whole: Double
        var length: Int
        switch tokens[index].kind {
        case .number(let value):
            whole = value
            length = 1
        case .clock(let first, let second, let third):
            guard clockAsNumber, third == nil, (1...9).contains(first), second < 60 else { return nil }
            return Reading(value: Double(first * 100 + second), isInteger: true, length: 1)
        case .word:
            guard let words = readNumberWords(tokens, at: index) else { return nil }
            whole = Double(words.value)
            length = words.length
        }
        // A fraction only ever follows a whole number.
        if whole == whole.rounded(), let fraction = readFraction(tokens, at: index + length, whole: whole) {
            return Reading(value: fraction.value, isInteger: false, length: length + fraction.length)
        }
        return Reading(value: whole, isInteger: whole == whole.rounded(), length: length)
    }

    private enum Last { case none, article, units, teen, tens, hundred, thousand }

    /// English 0–9999 plus gym shorthand: a leading word valued 1–9 followed by
    /// a tens group (`two twenty five` → 225, `three fifteen` → 315,
    /// `two oh five` → 205). `a`/`an` is one only before `hundred`/`thousand`;
    /// `and` is skipped only right after `hundred`; a units word followed by a
    /// tens word stops, and two units words never merge.
    static func readNumberWords(_ tokens: [VoiceToken], at index: Int) -> (value: Int, length: Int)? {
        if let first = word(tokens, index), let d = units[first], d >= 1, let second = word(tokens, index + 1) {
            if let t = tens[second] {
                if let third = word(tokens, index + 2), let u = units[third], u >= 1 {
                    return (d * 100 + t + u, 3)
                }
                return (d * 100 + t, 2)
            }
            if let t = teens[second] { return (d * 100 + t, 2) }
            if second == "oh" || second == "zero", let third = word(tokens, index + 2), let u = units[third] {
                return (d * 100 + u, 3)
            }
        }

        var i = index
        var total = 0
        var group = 0
        var last = Last.none
        while let w = word(tokens, i) {
            if articles.contains(w) {
                guard last == .none, let next = word(tokens, i + 1), next == "hundred" || next == "thousand" else { break }
                group = 1
                last = .article
            } else if w == "and" {
                guard last == .hundred, let next = word(tokens, i + 1),
                      units[next] != nil || teens[next] != nil || tens[next] != nil else { break }
            } else if let u = units[w] {
                switch last {
                case .none, .tens, .hundred, .thousand: group += u; last = .units
                case .units, .teen, .article: return finish(total, group, i - index, last)
                }
            } else if let t = teens[w] {
                switch last {
                case .none, .hundred, .thousand: group += t; last = .teen
                default: return finish(total, group, i - index, last)
                }
            } else if let t = tens[w] {
                switch last {
                case .none, .hundred, .thousand: group += t; last = .tens
                default: return finish(total, group, i - index, last)
                }
            } else if w == "hundred" {
                switch last {
                case .hundred, .thousand: return finish(total, group, i - index, last)
                case .none: group = 100
                default: group *= 100
                }
                last = .hundred
            } else if w == "thousand" {
                if last == .thousand { break }
                total += (group == 0 ? 1 : group) * 1000
                group = 0
                last = .thousand
            } else {
                break
            }
            i += 1
        }
        return finish(total, group, i - index, last)
    }

    private static func finish(_ total: Int, _ group: Int, _ length: Int, _ last: Last) -> (value: Int, length: Int)? {
        guard length > 0, last != .article, last != .none else { return nil }
        return (total + group, length)
    }

    /// `point five`, `point two five`, `point 25`, `and a half`, `and a quarter`.
    private static func readFraction(_ tokens: [VoiceToken], at index: Int, whole: Double) -> (value: Double, length: Int)? {
        guard whole >= 0, whole < 1e15, let first = word(tokens, index) else { return nil }
        if first == "point" {
            var digits = ""
            var i = index + 1
            while i < tokens.count {
                if let w = word(tokens, i), let d = units[w] {
                    digits.append(String(d))
                } else if case .number(let v) = tokens[i].kind, v == v.rounded(), v >= 0, tokens[i].text.allSatisfy(\.isNumber) {
                    digits.append(tokens[i].text)
                } else {
                    break
                }
                i += 1
            }
            guard !digits.isEmpty, let value = Double("\(Int(whole)).\(digits)") else { return nil }
            return (value, i - index)
        }
        if first == "and", let a = word(tokens, index + 1), articles.contains(a), let part = word(tokens, index + 2) {
            if part == "half" { return (whole + 0.5, 3) }
            if part == "quarter" { return (whole + 0.25, 3) }
        }
        return nil
    }

    /// A duration in seconds starting at `index`: a clock (`1:30`, `1:05:00`;
    /// a `d:dd` clock only when `clockAsDuration`, else it is a number),
    /// `N minutes [M [seconds]]`, `N seconds`, `a minute`, `half a minute`,
    /// `a minute thirty`, `a minute and a half`, fractional minutes.
    public static func readDuration(_ tokens: [VoiceToken], at index: Int, clockAsDuration: Bool) -> (seconds: Int, length: Int)? {
        guard index < tokens.count else { return nil }
        if case .clock(let first, let second, let third) = tokens[index].kind {
            if let third { return (first * 3600 + second * 60 + third, 1) }
            if clockAsDuration || !(1...9).contains(first) || second >= 60 { return (first * 60 + second, 1) }
            return nil
        }
        guard let first = word(tokens, index) else { return readCountedDuration(tokens, at: index) }
        if first == "half", let a = word(tokens, index + 1), articles.contains(a),
           let unit = word(tokens, index + 2), minuteWords.contains(unit) {
            return (30, 3)
        }
        if articles.contains(first), let unit = word(tokens, index + 1), minuteWords.contains(unit) {
            if word(tokens, index + 2) == "and", let a = word(tokens, index + 3), articles.contains(a), word(tokens, index + 4) == "half" {
                return (90, 5)
            }
            let (extra, length) = trailingSeconds(tokens, at: index + 2)
            return (60 + extra, 2 + length)
        }
        return readCountedDuration(tokens, at: index)
    }

    /// `N minutes [M [seconds]]` or `N seconds`, N digits or words, maybe fractional.
    private static func readCountedDuration(_ tokens: [VoiceToken], at index: Int) -> (seconds: Int, length: Int)? {
        guard let n = readNumber(tokens, at: index, clockAsNumber: false), n.value >= 0,
              let unit = word(tokens, index + n.length) else { return nil }
        // A pasted twenty-digit number is still "a duration" here; it is
        // clamped so the Int conversion cannot trap, and scored down later.
        if minuteWords.contains(unit) {
            let (extra, length) = trailingSeconds(tokens, at: index + n.length + 1)
            return (Int(min((n.value * 60).rounded(), 1e9)) + extra, n.length + 1 + length)
        }
        if secondWords.contains(unit) {
            return (Int(min(n.value.rounded(), 1e9)), n.length + 1)
        }
        return nil
    }

    /// The seconds after a minutes unit — "a minute thirty", "2 minutes 15
    /// seconds" — a whole number under sixty that nothing else claims.
    private static func trailingSeconds(_ tokens: [VoiceToken], at index: Int) -> (seconds: Int, length: Int) {
        guard let m = readNumber(tokens, at: index, clockAsNumber: false), m.isInteger, m.value >= 0, m.value < 60 else { return (0, 0) }
        let after = index + m.length
        if let unit = word(tokens, after), secondWords.contains(unit) { return (Int(m.value), m.length + 1) }
        if let next = word(tokens, after), claimingWords.contains(next) { return (0, 0) }
        if after < tokens.count, !tokens[after].isWord { return (0, 0) }
        return (Int(m.value), m.length)
    }
}
