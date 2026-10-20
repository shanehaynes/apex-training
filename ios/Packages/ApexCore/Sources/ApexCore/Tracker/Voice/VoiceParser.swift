import Foundation

/// A transcript into a `SpokenParse`: tokenize → extract the phrase → resolve
/// the exercise (or `.current`) → the hint is that exercise's fields → assign
/// slots → intent → score. Over several alternatives from the recognizer, the
/// best score wins and ties keep the engine's order.
public enum VoiceParser {
    public static func parse(_ transcript: String, context: VoiceContext) -> SpokenParse {
        parse(transcript, context: context, catalog: VoiceExercise.Catalog.cached(for: context))
    }

    static func parse(_ transcript: String, context: VoiceContext, catalog: VoiceExercise.Catalog) -> SpokenParse {
        let tokens = VoiceTokens.tokenize(transcript)
        let phrase = VoiceSlots.extractPhrase(tokens, knownKeys: catalog.knownKeys)
        let exercise = phrase.map { VoiceExercise.resolve($0.text, in: catalog) } ?? .current
        let hint: [SetField]
        switch exercise {
        case .current:
            hint = context.currentExercise?.fields ?? []
        case .resolved(scope: .session, let id, _, _):
            hint = context.session.first { $0.id == id }?.fields ?? []
        default:
            hint = []
        }
        let slots = VoiceSlots.assignSlots(tokens, phrase: phrase?.tokens, hint: hint)

        let status: SpokenParse.Status
        let intent: SpokenIntent?
        if slots.problems.contains(where: \.invalidates) {
            status = .invalid
            intent = nil
        } else if slots.isRepeat {
            status = .ok
            intent = .repeat
        } else if slots.values.hasAnyValue {
            status = .ok
            intent = .log(sets: slots.sets ?? 1, values: slots.values)
        } else {
            status = .empty
            intent = nil
        }
        var parse = SpokenParse(
            status: status, transcript: transcript, chosen: 0, intent: intent, exercise: exercise,
            ignored: slots.ignored, problems: slots.problems, score: 0, rules: slots.rules
        )
        parse.score = score(parse, unit: context.unit)
        return parse
    }

    /// The recognizer's alternatives, best score first; an equal score keeps
    /// the earlier (the engine's own ranking). No alternatives parse as "".
    public static func parse(alternatives: [String], context: VoiceContext) -> SpokenParse {
        let catalog = VoiceExercise.Catalog.cached(for: context)
        var best: SpokenParse?
        for (index, alternative) in alternatives.enumerated() {
            var parse = parse(alternative, context: context, catalog: catalog)
            parse.chosen = index
            if best.map({ parse.score > $0.score }) ?? true { best = parse }
        }
        return best ?? parse("", context: context)
    }

    /// ok +100 / empty 0 / invalid −100; +10 per value, +2 warm-up, +2 sets > 1;
    /// repeat +20; resolved +30, current +20, confirm +5, unresolved −10; −5 per
    /// ignored word; −3 per problem; implausible values (reps > 50, weight over
    /// 1500 lb / 700 kg, more than an hour) cost a little so a cleaner
    /// alternative wins.
    public static func score(_ parse: SpokenParse, unit: Weight.Unit?) -> Int {
        var score: Int
        switch parse.status {
        case .ok: score = 100
        case .empty: score = 0
        case .invalid: score = -100
        }
        switch parse.intent {
        case .log(let sets, let values):
            score += 10 * [values.weight != nil, values.reps != nil, values.durationSeconds != nil, values.rpe != nil].filter { $0 }.count
            if values.isWarmup { score += 2 }
            if sets > 1 { score += 2 }
            if let reps = values.reps, reps > 50 { score -= 20 }
            if let weight = values.weight, let value = weight.value {
                let ceiling: Double = (weight.unit ?? unit ?? .lb) == .kg ? 700 : 1500
                if value > ceiling { score -= 20 }
            }
            if let seconds = values.durationSeconds, seconds > 3600 { score -= 10 }
        case .repeat:
            score += 20
        case nil:
            break
        }
        switch parse.exercise {
        case .resolved: score += 30
        case .current: score += 20
        case .needsConfirmation: score += 5
        case .unresolved: score -= 10
        }
        score -= 5 * parse.ignored.count
        score -= 3 * parse.problems.count
        return score
    }
}
