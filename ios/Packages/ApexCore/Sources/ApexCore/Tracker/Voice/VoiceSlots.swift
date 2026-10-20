import Foundation

/// The slot rules R1–R17 (docs/ios/workstreams/W17-voice-set-logging.md): which
/// number is the weight, the reps, the sets, the rating, the duration. In
/// order; the first rule that claims a number wins. Everything here is a
/// literal table or a rule function, so the fixture is a contract a web port
/// can meet line by line.
public enum VoiceSlots {
    /// R17: more sets than this in one utterance is a misparse, not a plan.
    public static let maxSets = 10
    /// R12/R13: a bare number above this is a weight, at or below it reps.
    public static let bareWeightFloor = 50

    static let weightUnits: [String: Weight.Unit] = [
        "lb": .lb, "lbs": .lb, "pound": .lb, "pounds": .lb,
        "kg": .kg, "kgs": .kg, "kilo": .kg, "kilos": .kg, "kilogram": .kg, "kilograms": .kg,
    ]
    static let durationUnits: Set<String> = VoiceNumbers.minuteWords.union(VoiceNumbers.secondWords)
    static let repWords: Set<String> = ["rep", "reps"]
    static let setWords: Set<String> = ["set", "sets"]
    static let bodyweightWords: Set<String> = ["bw", "bodyweight"]
    static let signWords: Set<String> = ["plus", "minus"]
    /// Grammar between numbers; never part of a phrase, never "ignored".
    static let connectives: Set<String> = ["at", "for", "x", "by", "times", "and", "of"]
    static let pairConnectives: Set<String> = ["for", "at", "x", "by", "times"]
    static let repeatWords: Set<String> = ["again", "same", "repeat", "another", "more"]
    static let repeatBigrams: [(String, String)] = [("same", "again"), ("one", "more"), ("another", "one")]
    /// Dropped wherever they occur; "oh" is a number only inside gym
    /// shorthand ("two oh five"), elsewhere it is an interjection.
    static let fillers: Set<String> = ["okay", "ok", "um", "uh", "did", "log", "just", "i", "the", "please", "oh"]
    /// Bigrams that read as one keyword; their words alone are ordinary
    /// ("chin up", "pull ups", "body saw" stay phrases).
    static let bigrams: [(String, String)] = [("warm", "up"), ("body", "weight")]

    /// A word that is never part of an exercise phrase and ends the leading run.
    static func isKeyword(_ word: String) -> Bool {
        weightUnits[word] != nil || durationUnits.contains(word) || repWords.contains(word) || setWords.contains(word)
            || word == "rpe" || bodyweightWords.contains(word) || signWords.contains(word) || connectives.contains(word)
            || word == "warmup" || repeatWords.contains(word) || VoiceNumbers.numberWords.contains(word)
    }

    /// Per token: a keyword, or half of a keyword bigram.
    static func keywordMask(_ tokens: [VoiceToken]) -> [Bool] {
        var mask = tokens.map { !$0.isWord || isKeyword($0.text) }
        for i in tokens.indices.dropLast() where tokens[i].isWord && tokens[i + 1].isWord {
            if bigrams.contains(where: { $0.0 == tokens[i].text && $0.1 == tokens[i + 1].text }) {
                mask[i] = true
                mask[i + 1] = true
            }
        }
        return mask
    }

    /// The exercise phrase: the leading run of plain words up to the first
    /// number, clock or keyword, fillers dropped; else the trailing run after
    /// the last of those, a leading "on" dropped. The range is every token the
    /// run covered, fillers included, so the slot rules skip them.
    public static func extractPhrase(_ tokens: [VoiceToken]) -> (text: String, range: Range<Int>)? {
        let mask = keywordMask(tokens)
        func joins(_ i: Int) -> Bool { tokens[i].isWord && (!mask[i] || fillers.contains(tokens[i].text)) }
        var end = 0
        while end < tokens.count, joins(end) { end += 1 }
        let leading = tokens[0..<end].map(\.text).filter { !fillers.contains($0) }
        if !leading.isEmpty { return (leading.joined(separator: " "), 0..<end) }

        var start = tokens.count
        while start > 0, joins(start - 1) { start -= 1 }
        var trailing = tokens[start..<tokens.count].map(\.text).filter { !fillers.contains($0) }
        if trailing.first == "on" { trailing.removeFirst() }
        if !trailing.isEmpty { return (trailing.joined(separator: " "), start..<tokens.count) }
        return nil
    }

    /// What `assignSlots` found.
    public struct Result: Equatable, Sendable {
        public var values = SpokenValues()
        /// Spoken set count, validated (R17); nil when none was said.
        public var sets: Int?
        /// R16: a repeat word and not one number.
        public var isRepeat = false
        public var problems: [SpokenProblem] = []
        public var ignored: [String] = []
        public var rules: Set<String> = []
    }

    enum Slot {
        case weight, reps, sets, rpe, duration
        /// Claimed by a problem (one number too many): out of the running.
        case problem
    }

    /// One number (or bodyweight form, or duration) and the tokens it covers.
    struct Item {
        var start: Int
        var end: Int
        var value: Double
        var isInteger: Bool
        var slot: Slot?
    }

    private struct Builder {
        var result = Result()
        var items: [Item] = []
        var consumed: [Bool]
        var repeatAt: [Int] = []
        let tokens: [VoiceToken]
        let hint: [SetField]

        init(tokens: [VoiceToken], hint: [SetField]) {
            self.tokens = tokens
            self.hint = hint
            consumed = Array(repeating: false, count: tokens.count)
        }

        var clockIsDuration: Bool { hint.contains(.duration) }

        func word(_ i: Int) -> String? { i >= 0 && i < tokens.count && tokens[i].isWord ? tokens[i].text : nil }

        mutating func fire(_ rule: String) { result.rules.insert(rule) }

        mutating func problem(_ p: SpokenProblem) {
            if !result.problems.contains(p) { result.problems.append(p) }
        }

        mutating func consume(_ range: Range<Int>) {
            for i in range { consumed[i] = true }
        }

        // MARK: slots

        mutating func assignWeight(_ weight: SpokenWeight) {
            if result.values.weight != nil { problem(.duplicateWeight); fire("R14") } else { result.values.weight = weight }
        }

        mutating func assignReps(_ value: Double, isInteger: Bool) {
            if result.values.reps != nil { problem(.duplicateReps); fire("R14"); return }
            guard isInteger, value >= 0, value < Double(Int.max) else { problem(.repsNotInteger); return }
            result.values.reps = Int(value)
        }

        mutating func assignDuration(_ seconds: Int) {
            if result.values.durationSeconds != nil { problem(.duplicateDuration); fire("R14") } else { result.values.durationSeconds = seconds }
        }

        mutating func assignRpe(_ value: Double) {
            if result.values.rpe != nil { problem(.tooManyNumbers); fire("R14"); return }
            if let rpe = SetMetadata.parseRpe(String(value)) { result.values.rpe = rpe } else { problem(.rpeOutOfRange) }
        }

        /// R17: present → 1–10.
        mutating func assignSets(_ value: Double, isInteger: Bool) {
            fire("R17")
            if result.sets != nil { problem(.tooManyNumbers); fire("R14"); return }
            guard isInteger, value >= 1, value <= Double(maxSets) else { problem(.setsOutOfRange); return }
            result.sets = Int(value)
        }

        mutating func assign(_ slot: Slot, to index: Int) {
            let item = items[index]
            items[index].slot = slot
            switch slot {
            case .weight: assignWeight(SpokenWeight(value: item.value))
            case .reps: assignReps(item.value, isInteger: item.isInteger)
            case .sets: assignSets(item.value, isInteger: item.isInteger)
            case .rpe: assignRpe(item.value)
            case .duration: assignDuration(Int(min(item.value.rounded(), 1e9)))
            case .problem: break
            }
        }

        mutating func addItem(_ start: Int, _ end: Int, _ value: Double, isInteger: Bool, slot: Slot?) {
            items.append(Item(start: start, end: end, value: value, isInteger: isInteger, slot: slot))
            consume(start..<end)
        }

        // MARK: pass A — local patterns, left to right

        mutating func scan(skipping phrase: Range<Int>?) {
            var i = 0
            while i < tokens.count {
                if let phrase, phrase.contains(i) { i += 1; continue }
                let t = tokens[i]
                guard t.isWord else {
                    i = scanNumber(at: i)
                    continue
                }
                let w = t.text
                if w == "warmup" || (w == "warm" && word(i + 1) == "up") {
                    let length = w == "warmup" ? 1 : 2
                    result.values.isWarmup = true
                    fire("R15")
                    consume(i..<i + length)
                    i += length
                } else if bodyweightWords.contains(w) || (w == "body" && word(i + 1) == "weight") {
                    i = scanBodyweight(at: i, length: w == "body" ? 2 : 1)
                } else if repeatBigrams.contains(where: { $0.0 == w && $0.1 == word(i + 1) }) {
                    repeatAt.append(i)
                    consume(i..<i + 2)
                    i += 2
                } else if repeatWords.contains(w) {
                    repeatAt.append(i)
                    consume(i..<i + 1)
                    i += 1
                } else if w == "rpe", let n = VoiceNumbers.readNumber(tokens, at: i + 1, clockAsNumber: false) {
                    addItem(i, i + 1 + n.length, n.value, isInteger: n.isInteger, slot: .rpe)
                    assignRpe(n.value)
                    fire("R4")
                    i += 1 + n.length
                } else if repWords.contains(w), let n = VoiceNumbers.readNumber(tokens, at: i + 1, clockAsNumber: !clockIsDuration) {
                    addItem(i, i + 1 + n.length, n.value, isInteger: n.isInteger, slot: .reps)
                    assignReps(n.value, isInteger: n.isInteger)
                    fire("R2")
                    i += 1 + n.length
                } else if setWords.contains(w), word(i + 1) == "of",
                          let n = VoiceNumbers.readNumber(tokens, at: i + 2, clockAsNumber: !clockIsDuration) {
                    addItem(i, i + 2 + n.length, n.value, isInteger: n.isInteger, slot: .reps)
                    assignReps(n.value, isInteger: n.isInteger)
                    fire("R3")
                    i += 2 + n.length
                } else if VoiceNumbers.startsNumber(t) {
                    i = scanNumber(at: i)
                } else {
                    i += 1
                }
            }
        }

        /// R6: `bodyweight` / `body weight` / `bw` [`plus`|`minus` N [unit]].
        mutating func scanBodyweight(at i: Int, length: Int) -> Int {
            var weight = SpokenWeight(bodyweight: true)
            var end = i + length
            if let sign = word(end), signWords.contains(sign),
               let n = VoiceNumbers.readNumber(tokens, at: end + 1, clockAsNumber: false) {
                weight.sign = sign == "plus" ? 1 : -1
                weight.value = n.value
                end += 1 + n.length
                if let unitWord = word(end), let unit = weightUnits[unitWord] {
                    weight.unit = unit
                    end += 1
                }
            }
            addItem(i, end, weight.value ?? 0, isInteger: true, slot: .weight)
            assignWeight(weight)
            fire("R6")
            return end
        }

        /// R5, then R1–R4 on the token after a number; else an unmarked item.
        mutating func scanNumber(at i: Int) -> Int {
            if let d = VoiceNumbers.readDuration(tokens, at: i, clockAsDuration: clockIsDuration) {
                addItem(i, i + d.length, Double(d.seconds), isInteger: true, slot: .duration)
                assignDuration(d.seconds)
                fire("R5")
                return i + d.length
            }
            guard let n = VoiceNumbers.readNumber(tokens, at: i, clockAsNumber: !clockIsDuration) else {
                // A lone article reads as nothing and says nothing.
                if VoiceNumbers.articles.contains(tokens[i].text) { consume(i..<i + 1) }
                return i + 1
            }
            let after = i + n.length
            if let unitWord = word(after), let unit = weightUnits[unitWord] {
                addItem(i, after + 1, n.value, isInteger: n.isInteger, slot: .weight)
                assignWeight(SpokenWeight(value: n.value, unit: unit))
                fire("R1")
                return after + 1
            }
            if let next = word(after), repWords.contains(next) {
                addItem(i, after + 1, n.value, isInteger: n.isInteger, slot: .reps)
                assignReps(n.value, isInteger: n.isInteger)
                fire("R2")
                return after + 1
            }
            if let next = word(after), setWords.contains(next) {
                addItem(i, after + 1, n.value, isInteger: n.isInteger, slot: .sets)
                assignSets(n.value, isInteger: n.isInteger)
                fire("R3")
                var end = after + 1
                if word(end) == "of", let m = VoiceNumbers.readNumber(tokens, at: end + 1, clockAsNumber: !clockIsDuration) {
                    addItem(end, end + 1 + m.length, m.value, isInteger: m.isInteger, slot: .reps)
                    assignReps(m.value, isInteger: m.isInteger)
                    end += 1 + m.length
                }
                return end
            }
            // "8 rpe", but never the number before "rpe 8": that one is the rating.
            if word(after) == "rpe", VoiceNumbers.readNumber(tokens, at: after + 1, clockAsNumber: false) == nil {
                addItem(i, after + 1, n.value, isInteger: n.isInteger, slot: .rpe)
                assignRpe(n.value)
                fire("R4")
                return after + 1
            }
            addItem(i, after, n.value, isInteger: n.isInteger, slot: nil)
            return after
        }

        // MARK: pass B — connectives

        /// The one connective between two items, when nothing else is.
        func connective(between a: Item, and b: Item) -> String? {
            guard b.start == a.end + 1, let w = word(a.end), pairConnectives.contains(w) else { return nil }
            return w
        }

        /// R7: the number after `at` — a weight when none yet, else a rating
        /// when it could be one, else one number too many.
        mutating func applyR7(to index: Int) {
            fire("R7")
            let item = items[index]
            if result.values.weight == nil {
                assign(.weight, to: index)
            } else if item.value <= 10 {
                assign(.rpe, to: index)
            } else {
                items[index].slot = .problem
                problem(.tooManyNumbers)
                fire("R14")
            }
        }

        /// R8: the other side of a pair takes the slot that completes the marked one.
        func complement(of slot: Slot, connective: String, other: Item) -> Slot? {
            switch slot {
            case .weight, .sets: return .reps
            case .reps:
                if connective == "for" || connective == "at" { return .weight }
                return other.value <= 10 ? .sets : .weight
            case .rpe, .duration, .problem: return nil
            }
        }

        mutating func pairs() {
            // R7 for an `at` with no number before it ("for at 225", "at 225").
            for k in items.indices where items[k].slot == nil && items[k].start > 0 && word(items[k].start - 1) == "at" {
                let adjacentLeft = k > 0 && items[k - 1].end == items[k].start - 1
                if !adjacentLeft { applyR7(to: k) }
            }
            var changed = true
            while changed {
                changed = false
                var k = 0
                while k + 1 < items.count {
                    defer { k += 1 }
                    let a = items[k], b = items[k + 1]
                    guard let c = connective(between: a, and: b) else { continue }
                    switch (a.slot, b.slot) {
                    case (nil, nil):
                        changed = true
                        switch c {
                        case "for":
                            fire("R9")
                            assign(.weight, to: k)
                            assign(.reps, to: k + 1)
                        case "at":
                            fire("R10")
                            assign(.reps, to: k)
                            assign(.weight, to: k + 1)
                        default:
                            fire("R11")
                            if a.value <= 10, b.value <= 30 {
                                assign(.sets, to: k)
                                assign(.reps, to: k + 1)
                            } else {
                                assign(.reps, to: a.value <= b.value ? k : k + 1)
                                assign(.weight, to: a.value <= b.value ? k + 1 : k)
                            }
                            // A third item in the chain takes the next of sets, reps, weight.
                            if k + 2 < items.count, items[k + 2].slot == nil,
                               let third = connective(between: items[k + 1], and: items[k + 2]), third != "for", third != "at" {
                                let next: Slot? = result.sets == nil ? .sets : result.values.reps == nil ? .reps : result.values.weight == nil ? .weight : nil
                                if let next { assign(next, to: k + 2) } else { items[k + 2].slot = .problem; problem(.tooManyNumbers); fire("R14") }
                            }
                        }
                    case (.some, nil):
                        changed = true
                        if c == "at" {
                            applyR7(to: k + 1)
                        } else if let slot = complement(of: a.slot!, connective: c, other: b) {
                            fire("R8")
                            assign(slot, to: k + 1)
                        } else {
                            changed = false
                        }
                    case (nil, .some):
                        if let slot = complement(of: b.slot!, connective: c, other: a) {
                            fire("R8")
                            assign(slot, to: k)
                            changed = true
                        }
                    case (.some, .some):
                        continue
                    }
                }
            }
        }

        // MARK: pass C — what is left

        mutating func leftovers() {
            let left = items.indices.filter { items[$0].slot == nil }
            switch left.count {
            case 0:
                return
            case 1:
                fire("R12")
                let n = items[left[0]]
                if hint == [.duration] {
                    assign(.duration, to: left[0])
                } else if hint.contains(.reps), !hint.contains(.weight) {
                    assign(.reps, to: left[0])
                } else if hint.contains(.weight), !hint.contains(.reps) {
                    assign(.weight, to: left[0])
                } else {
                    assign(n.value > Double(bareWeightFloor) ? .weight : .reps, to: left[0])
                }
            case 2:
                fire("R13")
                let a = left[0], b = left[1]
                let big = left.filter { items[$0].value > Double(bareWeightFloor) }
                if big.count == 1 {
                    assign(.weight, to: big[0])
                    assign(.reps, to: big[0] == a ? b : a)
                } else if big.isEmpty {
                    assign(.reps, to: a)
                    assign(.weight, to: b)
                    problem(.barePair)
                } else {
                    items[a].slot = .problem
                    items[b].slot = .problem
                    problem(.ambiguousNumbers)
                }
            default:
                fire("R14")
                for k in left { items[k].slot = .problem }
                problem(.tooManyNumbers)
            }
        }

        mutating func finish(phrase: Range<Int>?) -> Result {
            let hasValues = result.values.hasAnyValue
            result.isRepeat = !repeatAt.isEmpty && items.isEmpty && !hasValues
            if result.isRepeat { fire("R16") }
            var ignored: [String] = []
            for i in tokens.indices {
                if let phrase, phrase.contains(i) { continue }
                if repeatAt.contains(i) {
                    if !result.isRepeat { ignored.append(tokens[i].text) }
                    continue
                }
                guard !consumed[i], tokens[i].isWord else { continue }
                let w = tokens[i].text
                if fillers.contains(w) || connectives.contains(w) || VoiceNumbers.articles.contains(w) { continue }
                ignored.append(w)
            }
            result.ignored = ignored
            return result
        }
    }

    /// R1–R17 over the tokens outside the phrase. `hint` is the target
    /// exercise's logged fields: it reads a bare number and a `d:dd` clock,
    /// nothing else.
    public static func assignSlots(_ tokens: [VoiceToken], phrase: Range<Int>?, hint: [SetField]) -> Result {
        var builder = Builder(tokens: tokens, hint: hint)
        builder.scan(skipping: phrase)
        builder.pairs()
        builder.leftovers()
        return builder.finish(phrase: phrase)
    }
}
