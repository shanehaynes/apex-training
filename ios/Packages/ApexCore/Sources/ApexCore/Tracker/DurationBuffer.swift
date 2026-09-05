import Foundation

/// The stopwatch-style duration input's model (src/lib/durationBuffer.ts,
/// src/lib/time.ts). Digits fill right-to-left — typing 2, 3, 0 reads
/// 0:02 → 0:23 → 2:30 — so a keystroke is never ambiguous: the display always
/// shows the duration that will be stored. Ported with the web's test vectors
/// (D-024): it runs at keystroke time, before any request exists.
public enum DurationBuffer {
    public static let maxDigits = 6

    /// A value the stopwatch control can represent: empty, or a single clean
    /// duration token ("2", "90s", "1:30", "2 min"). Anything else — "10s on
    /// 5s off", "each side" — stays free text so nothing typed is dropped.
    private static let plainDuration = try! NSRegularExpression( // swiftlint:disable:this force_try
        pattern: #"^(\d+:\d{1,2}(:\d{1,2})?|\d+(\.\d+)?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?)$"#,
        options: [.caseInsensitive]
    )

    public static func isPlain(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        return plainDuration.firstMatch(in: trimmed, range: range) != nil
    }

    /// Right-split the buffer into h/mm/ss: last two digits are seconds, next
    /// two minutes, the rest hours. "0:90" is a legal buffer state — overflow
    /// rolls up only on commit, through seconds math.
    public static func digitsToSeconds(_ digits: String) -> Int {
        let sec = Int(digits.suffix(2)) ?? 0
        let rest = String(digits.dropLast(2))
        let min = Int(rest.suffix(2)) ?? 0
        let hrs = Int(rest.dropLast(2)) ?? 0
        return hrs * 3600 + min * 60 + sec
    }

    /// Literal group display while typing: "2" → "0:02", "90" → "0:90",
    /// "230" → "2:30", "12345" → "1:23:45". Empty shows nothing so the
    /// placeholder stays visible.
    public static func digitsToDisplay(_ digits: String) -> String {
        if digits.isEmpty { return "" }
        let sec = pad2(String(digits.suffix(2)))
        let rest = String(digits.dropLast(2))
        let min = rest.suffix(2).isEmpty ? "0" : String(rest.suffix(2))
        let hrs = String(rest.dropLast(2))
        return hrs.isEmpty ? "\(min):\(sec)" : "\(hrs):\(pad2(min)):\(sec)"
    }

    /// Record format (`formatSeconds`): "90s" under a minute, "2:30" beyond,
    /// "1:05:00" beyond an hour.
    public static func formatSeconds(_ total: Double) -> String {
        let s = Int(total.rounded())
        if s < 60 { return "\(s)s" }
        let h = s / 3600
        let m = (s % 3600) / 60
        let ss = pad2(String(s % 60))
        return h > 0 ? "\(h):\(pad2(String(m))):\(ss)" : "\(m):\(ss)"
    }

    /// Workout timer format (`formatElapsed`): "05:30", "1:05:30" — always-padded mm:ss.
    public static func formatElapsed(_ totalSeconds: Int) -> String {
        let t = max(0, totalSeconds)
        let h = t / 3600
        let mm = pad2(String((t % 3600) / 60))
        let ss = pad2(String(t % 60))
        return h > 0 ? "\(h):\(mm):\(ss)" : "\(mm):\(ss)"
    }

    /// A completion time reads as a clock (`formatSecondsClock` in records.ts):
    /// "41:32", "1:02:03" — minutes unpadded until there are hours.
    public static func formatClock(_ seconds: Int) -> String {
        let t = max(0, seconds)
        let h = t / 3600
        let m = (t % 3600) / 60
        let mm = h > 0 ? pad2(String(m)) : String(m)
        return "\(h > 0 ? "\(h):" : "")\(mm):\(pad2(String(t % 60)))"
    }

    /// `parseDurationSeconds`: "90s" → 90, "2 min" → 120, "1:30" → 90,
    /// "1:05:00" → 3900, bare "60" → 60. Unknown units return nil — no guessing.
    public static func parseDurationSeconds(_ value: String?) -> Double? {
        guard let value else { return nil }
        let v = value.trimmingCharacters(in: .whitespaces).lowercased()
        if v.isEmpty { return nil }

        let colonParts = v.split(separator: ":", omittingEmptySubsequences: false)
        if colonParts.count == 2 || colonParts.count == 3 {
            let numbers = colonParts.map { Int($0) }
            if numbers.allSatisfy({ $0 != nil }), colonParts[0].allSatisfy(\.isNumber),
               colonParts.dropFirst().allSatisfy({ (1...2).contains($0.count) && $0.allSatisfy(\.isNumber) }) {
                let n = numbers.map { $0! }
                return n.count == 3 ? Double(n[0] * 3600 + n[1] * 60 + n[2]) : Double(n[0] * 60 + n[1])
            }
        }

        var index = v.startIndex
        var numberText = ""
        var seenDot = false
        while index < v.endIndex, v[index].isNumber || (v[index] == "." && !seenDot && !numberText.isEmpty) {
            if v[index] == "." { seenDot = true }
            numberText.append(v[index])
            index = v.index(after: index)
        }
        guard let n = Double(numberText), n > 0 else { return nil }
        var unit = ""
        var cursor = v[index...].drop(while: { $0 == " " })
        while let c = cursor.first, c.isLetter {
            unit.append(c)
            cursor = cursor.dropFirst()
        }
        if unit.isEmpty || unit == "s" || unit.hasPrefix("sec") { return n }
        if unit == "m" || unit.hasPrefix("min") { return n * 60 }
        if unit == "h" || unit.hasPrefix("hr") || unit.hasPrefix("hour") { return n * 3600 }
        return nil
    }

    private static func pad2(_ s: String) -> String { s.count >= 2 ? s : String(repeating: "0", count: 2 - s.count) + s }
}

/// The state `DurationInput.tsx` keeps inline: which of the two modes the field
/// is in and the live digit buffer while it is focused. The view owns the
/// stored value and the focus; this decides what to show and what to store.
/// U29: no blur/refocus dance — the view swaps the keyboard on `mode`.
public struct DurationEntry: Equatable, Sendable {
    public enum Mode: Sendable { case stopwatch, text }

    public private(set) var mode: Mode
    /// The digit buffer while focused in stopwatch mode; nil when not editing.
    public private(set) var buffer: String?
    private var isFocused = false
    private var lastEmitted: String?

    public init(value: String) {
        mode = DurationBuffer.isPlain(value) ? .stopwatch : .text
        buffer = nil
    }

    public var isEditing: Bool { buffer != nil }

    public mutating func beginEditing() {
        isFocused = true
        if mode == .stopwatch { buffer = "" }
    }

    public mutating func endEditing() {
        isFocused = false
        buffer = nil
    }

    /// The text the field shows: the stored value, or the live groups while typing.
    public func display(stored: String) -> String {
        switch mode {
        case .text: stored
        case .stopwatch: buffer.map(DurationBuffer.digitsToDisplay) ?? stored
        }
    }

    /// While filling, the stored value moves into the placeholder (re-entry is
    /// retype, not edit); a ghost shows when nothing is stored; "0:00" otherwise.
    public func placeholder(stored: String, ghost: String?) -> String {
        guard mode == .stopwatch else { return "" }
        if !stored.isEmpty { return stored }
        if let ghost, !ghost.isEmpty { return ghost }
        return "0:00"
    }

    /// The field's text changed to `raw`. Returns the value to store, or nil
    /// when the keystroke is ignored (a seventh digit).
    public mutating func change(raw: String) -> String? {
        switch mode {
        case .stopwatch:
            if raw.contains(where: { !($0.isASCII && $0.isNumber) && $0 != ":" }) {
                return switchToText(raw)
            }
            var digits = raw.filter { $0.isASCII && $0.isNumber }
            while digits.hasPrefix("0") { digits.removeFirst() }
            if digits.count > DurationBuffer.maxDigits { return nil }
            buffer = digits
            return emit(digits.isEmpty ? "" : DurationBuffer.formatSeconds(Double(DurationBuffer.digitsToSeconds(digits))))
        case .text:
            if raw.isEmpty {
                mode = .stopwatch
                buffer = isFocused ? "" : nil
            }
            return emit(raw)
        }
    }

    /// Backspace with an empty buffer clears a stored value outright — without
    /// it the user would have to type a throwaway digit first. Returns the value
    /// to store, or nil when there is nothing to clear.
    public func deleteBackwardOnEmptyBuffer(stored: String) -> String? {
        mode == .stopwatch && buffer == "" && !stored.isEmpty ? "" : nil
    }

    /// The stored value changed from outside (a shadow commit, a queue replay):
    /// re-derive the mode — unless the field is mid-edit or the change is our own
    /// emit, since a text-mode intermediate like "10" is coincidentally plain.
    public mutating func sync(stored: String) {
        guard buffer == nil, stored != lastEmitted else { return }
        mode = DurationBuffer.isPlain(stored) ? .stopwatch : .text
    }

    /// Reconstruct what was actually typed — "1", "0", "s" is "10s", not
    /// "0:10s" — and drop a lone trailing ".", the decimal pad's escape hatch.
    private mutating func switchToText(_ raw: String) -> String {
        let shown = DurationBuffer.digitsToDisplay(buffer ?? "")
        var seed = raw.hasPrefix(shown) ? (buffer ?? "") + String(raw.dropFirst(shown.count)) : raw
        while seed.hasSuffix(".") { seed.removeLast() }
        mode = .text
        buffer = nil
        return emit(seed)
    }

    private mutating func emit(_ value: String) -> String {
        lastEmitted = value
        return value
    }
}
