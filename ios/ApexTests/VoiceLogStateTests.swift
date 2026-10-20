import ApexCore
import ApexFeatures
import ApexSpeech
import XCTest

/// W17 M2: what the strip shows for each thing the recognizer and the parser
/// can say, the bias the recognizer is given, and the strip's line.
@MainActor
final class VoiceLogStateTests: XCTestCase {
    func testARefusedSheetIsDeniedAndNoRecognizerMeansNoMic() async {
        await VoiceSupport.withVoiceEnabled {
            let refused = await VoiceSupport.make(authorization: .notDetermined, grantOnRequest: false)
            XCTAssertTrue(refused.model.showsVoice)
            refused.model.tapMic()
            await VoiceSupport.waitUntil { refused.model.voice == .denied(reason: TrackerModel.deniedReason) }
            XCTAssertEqual(refused.fake.requestCount, 1, "both sheets, once")
            XCTAssertEqual(refused.model.voiceFailCount, 1)

            let none = await VoiceSupport.make(authorization: .unavailable, availability: .unavailable(reason: "no recognizer"))
            XCTAssertFalse(none.model.showsVoice)

            let off = await VoiceSupport.make()
            await VoiceSupport.withVoiceEnabled(false) {
                XCTAssertFalse(off.model.showsVoice, "the toggle is off")
            }
        }
    }

    func testDictationOffAndMissingAssetsPointAtSettings() async {
        await VoiceSupport.withVoiceEnabled {
            for (failure, reason) in [
                (SpeechFailure.dictationDisabled, TrackerModel.dictationOffReason),
                (.assetsMissing, TrackerModel.assetsMissingReason),
                (.notAuthorized, TrackerModel.deniedReason),
            ] {
                let made = await VoiceSupport.make()
                made.model.tapMic()
                await VoiceSupport.waitUntil { made.model.voice.isListening }
                made.fake.fail(failure)
                await VoiceSupport.waitUntil { made.model.voice == .denied(reason: reason) }
                XCTAssertEqual(made.journal.load().entries.last?.endReason, .failed)
            }
            let interrupted = await VoiceSupport.make()
            interrupted.model.tapMic()
            await VoiceSupport.waitUntil { interrupted.model.voice.isListening }
            interrupted.fake.fail(.interrupted)
            await VoiceSupport.waitUntil { interrupted.model.voice == .failed(.interrupted, reason: "Interrupted — try again") }
            XCTAssertEqual(interrupted.journal.load().entries.last?.endReason, .interrupted)
        }
    }

    func testPartialsAreTheTranscript() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.model.voice == .listening(partial: "", heardSpeech: false) }
            made.fake.emit(.partial(""))
            await VoiceSupport.waitUntil { made.model.voice == .listening(partial: "", heardSpeech: true) }
            made.fake.emit(.partial("fixture"))
            await VoiceSupport.waitUntil { made.model.voice == .listening(partial: "fixture", heardSpeech: true) }
            made.fake.emit(.partial("fixture press 225"))
            await VoiceSupport.waitUntil { made.model.voice == .listening(partial: "fixture press 225", heardSpeech: true) }
        }
    }

    func testANearMissAsksAndKeepsTheValues() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture prss 120 for 3"])
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.model.voice.isConfirming }
            guard case .confirming(let intent, let candidates) = made.model.voice else { return XCTFail("\(made.model.voice)") }
            XCTAssertEqual(candidates.map(\.id), ["fx-press"])
            XCTAssertEqual(candidates.first?.match, .near)
            XCTAssertEqual(intent, .log(sets: 1, values: SpokenValues(weight: SpokenWeight(value: 120), reps: 3)))
            made.model.confirmSpoken(candidates[0])
            XCTAssertEqual(made.model.set(at: VoiceSupport.press1)?.actualWeight, "120")
            XCTAssertEqual(made.model.set(at: VoiceSupport.press1)?.actualReps, "3")
        }
    }

    func testAnUnknownNameIsUnresolvedAndNoiseIsAFailure() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["incline press 5 at 185", "okay um", "5 reps 8 reps"])
            made.model.tapMic()
            await VoiceSupport.waitUntil { if case .unresolved = made.model.voice { return true } else { return false } }
            guard case .unresolved(let phrase, let intent) = made.model.voice else { return XCTFail() }
            XCTAssertEqual(phrase, "incline press")
            XCTAssertEqual(intent, .log(sets: 1, values: SpokenValues(weight: SpokenWeight(value: 185), reps: 5)))
            XCTAssertEqual(made.model.voicePhrase, "incline press", "what Pick… searches for")
            XCTAssertEqual(made.journal.load().entries.last?.action, .unresolved)

            made.model.tapMic()
            await VoiceSupport.waitUntil { made.model.voice == .failed(nil, reason: TrackerModel.notASetReason) }
            XCTAssertEqual(made.journal.load().entries.last?.parse.status, "empty")
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.journal.load().entries.count == 3 }
            XCTAssertEqual(made.model.voice, .failed(nil, reason: TrackerModel.notASetReason))
            XCTAssertEqual(made.journal.load().entries.last?.parse.status, "invalid")
            XCTAssertEqual(made.model.set(at: VoiceSupport.press1)?.actualWeight, "", "nothing was logged")
        }
    }

    func testAPhraselessSetWithNoCurrentExerciseAsksOverTheSession() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["225 for 5"])
            // Both planned rows filled by hand, nothing logged by voice: no current.
            made.model.setValue("200", .weight, at: VoiceSupport.press1)
            made.model.setValue("5", .reps, at: VoiceSupport.press1)
            made.model.setValue("200", .weight, at: VoiceSupport.press2)
            made.model.setValue("5", .reps, at: VoiceSupport.press2)
            XCTAssertNil(made.model.editor.currentExercise(lastLogged: nil))
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.model.voice.isConfirming }
            let candidates = made.model.voice.candidates ?? []
            XCTAssertEqual(candidates.map(\.id), ["fx-press"], "the session's set-tracked exercises, at most four; the cardio row never")
            XCTAssertLessThanOrEqual(candidates.count, 4)
            made.model.confirmSpoken(candidates[0])
            XCTAssertEqual(made.model.voice.applied?.keys, [VoiceSupport.press3], "an extra, both planned rows being full")
        }
    }

    func testTheBiasIsNamesFirstCappedAndFreeOfCommonWords() async {
        await VoiceSupport.withVoiceEnabled {
            let many = (0..<150).map { ExerciseDefinition(id: "d\($0)", canonicalName: "Lift \($0)", aliases: ["L\($0)"], category: "strength") }
            let made = await VoiceSupport.make(library: VoiceSupport.library + many)
            let names = made.model.voiceBias().names
            XCTAssertEqual(names.first, "Fixture Press", "today's exercise first")
            XCTAssertEqual(names[1], "fx press", "its alias next, from the library entry")
            XCTAssertTrue(names.contains("Romanian Deadlift"))
            XCTAssertTrue(names.contains("Stiff-Leg Deadlift"))
            XCTAssertFalse(names.contains("Retired Lift"), "archived names are not suggested")
            XCTAssertEqual(names.count, 100)
            XCTAssertEqual(names.last, "RPE")
            XCTAssertEqual(Set(names.map { $0.lowercased() }).count, names.count, "deduped")
            for word in ["for", "at", "and", "reps", "sets", "the"] { XCTAssertFalse(names.contains(word), word) }
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.fake.biases.count == 1 }
            XCTAssertEqual(made.fake.biases[0], names)
        }
    }

    func testTheStripsLineNamesTheExerciseAndEveryValue() {
        func label(_ values: SpokenValues, sets: Int = 1, unit: Weight.Unit = .lb) -> String {
            TrackerModel.label(for: .log(sets: sets, values: values), exerciseName: "Bench Press", unit: unit)
        }
        XCTAssertEqual(label(SpokenValues(weight: SpokenWeight(value: 225), reps: 5)), "Logged Bench Press · 225 lb × 5")
        XCTAssertEqual(label(SpokenValues(weight: SpokenWeight(value: 62.5, unit: .kg), reps: 8), unit: .lb), "Logged Bench Press · 62.5 kg × 8")
        XCTAssertEqual(label(SpokenValues(weight: SpokenWeight(value: 100), reps: 5), unit: .kg), "Logged Bench Press · 100 kg × 5")
        XCTAssertEqual(label(SpokenValues(weight: SpokenWeight(value: 25, bodyweight: true, sign: 1), reps: 5)), "Logged Bench Press · BW+25 × 5")
        XCTAssertEqual(label(SpokenValues(reps: 8)), "Logged Bench Press · 8 reps")
        XCTAssertEqual(label(SpokenValues(weight: SpokenWeight(value: 225))), "Logged Bench Press · 225 lb")
        XCTAssertEqual(label(SpokenValues(durationSeconds: 90)), "Logged Bench Press · 1:30")
        XCTAssertEqual(label(SpokenValues(weight: SpokenWeight(value: 225), reps: 5, rpe: 8, isWarmup: true), sets: 3), "Logged Bench Press · 225 lb × 5 · RPE 8 · warm-up · 3 sets")
        XCTAssertEqual(TrackerModel.label(for: .repeat, exerciseName: "Bench Press", unit: .lb), "Logged Bench Press · same as last set")
        XCTAssertEqual(TrackerModel.label(for: .repeat, exerciseName: "", unit: .lb), "Logged set · same as last set")
    }
}
