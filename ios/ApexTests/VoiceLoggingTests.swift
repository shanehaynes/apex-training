import ApexCore
import ApexFeatures
import ApexSpeech
import XCTest

/// W17 M2: the tracker logs what it hears. Over the fake recognizer, the
/// fixtures, an in-memory queue and a test clock; the end-of-utterance policy
/// is driven by `voiceTick()` against that clock, as the app's 100 ms timer
/// drives it.
@MainActor
final class VoiceLoggingTests: XCTestCase {
    private let press1 = VoiceSupport.press1
    private let press2 = VoiceSupport.press2
    private let press3 = VoiceSupport.press3

    // MARK: - Applying

    func testAnExactSessionNameFillsTheFirstEmptyRowAndClearsItsGhost() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture press 225 for 5", "fixture press 235 for 3", "fixture press 245 for 1"])
            let model = made.model
            XCTAssertTrue(model.showsVoice)
            XCTAssertNotNil(model.set(at: press1)?.shadow, "the fixture's set 1 has a ghost")

            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            XCTAssertEqual(model.voice.appliedLabel, "Logged Fixture Press · 225 lb × 5")
            XCTAssertEqual(model.set(at: press1)?.actualWeight, "225")
            XCTAssertEqual(model.set(at: press1)?.actualReps, "5")
            XCTAssertNil(model.set(at: press1)?.shadow, "the ghost is gone, not committed")
            XCTAssertFalse(model.focusSet(at: press1), "nothing left to commit on focus")
            XCTAssertEqual(model.loggedSetCount, 1)
            XCTAssertEqual(model.voice.applied?.keys, [press1])
            XCTAssertEqual(model.voice.applied?.kind, .planned)
            XCTAssertEqual(made.fake.biases[0].first, "Fixture Press", "today's names lead the bias")

            // The next utterance takes the next empty row; the third adds an extra.
            model.tapMic()
            await VoiceSupport.waitUntil { model.set(at: self.press2)?.actualWeight == "235" }
            XCTAssertEqual(model.voice.applied?.keys, [press2])
            model.tapMic()
            await VoiceSupport.waitUntil { model.set(at: self.press3)?.actualWeight == "245" }
            XCTAssertEqual(model.voice.applied?.kind, .extra)
            XCTAssertEqual(model.loggedSetCount, 3, "one per utterance")
            XCTAssertEqual(made.journal.load().entries.map(\.action), [.applied, .applied, .applied])
        }
    }

    func testThreeSetsSpanThePlannedRowsThenAnExtra() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["3 sets of 5 at 225"])
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            XCTAssertEqual(model.voice.applied?.keys, [press1, press2, press3])
            XCTAssertEqual(model.voice.appliedLabel, "Logged Fixture Press · 225 lb × 5 · 3 sets")
            XCTAssertEqual(model.set(at: press3)?.isExtra, true)
            XCTAssertEqual(model.loggedSetCount, 3)
        }
    }

    func testRepeatCopiesTheLastSet() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture press 225 for 5", "again"])
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            model.tapMic()
            await VoiceSupport.waitUntil { model.set(at: self.press2)?.actualReps == "5" }
            XCTAssertEqual(model.set(at: press2)?.actualWeight, "225")
            XCTAssertEqual(model.voice.appliedLabel, "Logged Fixture Press · same as last set")
        }
    }

    func testALibraryNameAsksFirstThenAddsAndLogsAndUndoRemovesBoth() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["romanian deadlift 8 at 185"])
            let model = made.model
            let before = model.editor.groups.flatMap(\.exercises).count
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isConfirming }
            let candidates = model.voice.candidates ?? []
            XCTAssertEqual(candidates.map(\.id), ["rdl"], "an exact library hit asks in v1 (D-059)")
            XCTAssertEqual(candidates.first?.scope, .library)
            XCTAssertEqual(model.voiceConfirmCount, 1)
            XCTAssertEqual(made.journal.load().entries.last?.action, .confirming)

            model.confirmSpoken(candidates[0])
            XCTAssertTrue(model.voice.isApplied)
            XCTAssertEqual(model.editor.groups.flatMap(\.exercises).count, before + 1, "added for today")
            let added = model.editor.groups.flatMap(\.exercises).first { $0.exercise.name == "Romanian Deadlift" }
            XCTAssertNotNil(added)
            XCTAssertEqual(added?.sets.first?.actualWeight, "185")
            XCTAssertEqual(added?.sets.first?.actualReps, "8")
            if case .addedExercise(let id)? = model.voice.applied?.kind { XCTAssertEqual(id, added?.exercise.id) } else { XCTFail("undo must remove the exercise: \(String(describing: model.voice))") }

            model.undoSpoken()
            XCTAssertEqual(model.voice, .idle)
            XCTAssertEqual(model.editor.groups.flatMap(\.exercises).count, before, "the exercise went with its set")
        }
    }

    func testCardioAPitchAndAFinishedWorkoutTakeNoSpokenSet() async {
        await VoiceSupport.withVoiceEnabled {
            // A cardio pick: the row cannot take a set, so nothing is left behind.
            let cardio = await VoiceSupport.make(script: ["incline press 5 at 185"])
            cardio.model.tapMic()
            await VoiceSupport.waitUntil { if case .unresolved = cardio.model.voice { return true } else { return false } }
            let before = cardio.model.editor.groups.flatMap(\.exercises).count
            cardio.model.pickSpoken(VoiceSupport.library[2])
            XCTAssertEqual(cardio.model.voice, .failed(nil, reason: TrackerModel.notASetRowReason))
            XCTAssertEqual(cardio.model.editor.groups.flatMap(\.exercises).count, before, "the cardio row was not added")

            // A pitch (bootstrap-full's Mixed Arete) is not a session candidate at all.
            let full = await VoiceSupport.make(script: ["mixed arete 5 at 225"], full: true)
            full.model.tapMic()
            await VoiceSupport.waitUntil { full.model.voice != .idle && !full.model.voice.isListening }
            if case .unresolved(let phrase, _) = full.model.voice { XCTAssertEqual(phrase, "mixed arete") } else { XCTFail("\(full.model.voice)") }

            // Finished: no mic, and a tap does nothing.
            let finished = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            await finished.model.requestFinish(force: true)
            XCTAssertTrue(finished.model.isFinished)
            XCTAssertFalse(finished.model.showsVoice)
            finished.model.tapMic()
            try? await Task.sleep(for: .milliseconds(50))
            XCTAssertEqual(finished.model.voice, .idle)
        }
    }

    func testTheSaveCarriesABareWeightAndASpokenUnit() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture press 225 for 5", "fixture press 100 kilos for 5"])
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            await model.flushEdits()
            var saves = made.transport.bodies(action: "save")
            XCTAssertEqual(saves.count, 1)
            XCTAssertTrue(saves[0].contains(#""actual_weight":"225""#), "bare, like a typed 225: \(saves[0])")
            XCTAssertTrue(saves[0].contains(#""actual_reps":"5""#))

            model.tapMic()
            await VoiceSupport.waitUntil { model.set(at: self.press2)?.actualWeight == "100 kg" }
            await model.flushEdits()
            saves = made.transport.bodies(action: "save")
            XCTAssertEqual(saves.count, 2)
            XCTAssertTrue(saves[1].contains(#""actual_weight":"100 kg""#), "a spoken unit is kept: \(saves[1])")
        }
    }

    // MARK: - Rest and Undo

    func testRepsStartTheRestAndUndoPutsItBack() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            let model = made.model
            XCTAssertFalse(model.rest.isRunning)
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            XCTAssertTrue(model.rest.isRunning, "reps start the exercise's rest, as typing does")
            XCTAssertEqual(model.restRemaining, 120, "the fixture's 2 min")

            model.undoSpoken()
            XCTAssertFalse(model.rest.isRunning, "the rest is exactly as it was before the set")
            XCTAssertEqual(model.restRemaining, 0)
            XCTAssertEqual(model.set(at: press1)?.actualWeight, "")
            XCTAssertNotNil(model.set(at: press1)?.shadow, "the ghost is back")
            XCTAssertEqual(made.journal.load().entries.last?.undoneWithinWindow, true)

            // The row is unspent again: logging it by hand starts its rest once more.
            model.setValue("5", .reps, at: press1)
            XCTAssertTrue(model.rest.isRunning, "re-logging the reverted row starts its rest again")
        }
    }

    func testUndoRestoresARestThatWasAlreadyRunning() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            let model = made.model
            model.setValue("5", .reps, at: press2)
            XCTAssertTrue(model.rest.isRunning)
            made.clock.advance(by: 30)
            model.voiceTick()
            let before = model.rest
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            XCTAssertNotEqual(model.rest.endsAt, before.endsAt, "the new set restarted the rest")
            model.undoSpoken()
            XCTAssertEqual(model.rest, before, "back to the rest the typed set started, to the second")
        }
    }

    func testUndoBeforeTheFlushSendsNoRowAndAfterItSendsADelete() async {
        await VoiceSupport.withVoiceEnabled {
            // Before: the apply's save never left (the debounce), so the one
            // save that follows carries no row for the key — only the removal
            // that a planned row's undo records, which the server treats as a
            // no-op for a row it never saw.
            let early = await VoiceSupport.make(script: ["fixture press 225 for 5"], stalled: true)
            early.model.tapMic()
            await VoiceSupport.waitUntil { early.model.voice.isApplied }
            XCTAssertTrue(early.transport.bodies(action: "save").isEmpty, "the debounce has not fired")
            early.model.undoSpoken()
            await early.model.flushEdits()
            let earlySaves = early.transport.bodies(action: "save")
            XCTAssertEqual(earlySaves.count, 1)
            XCTAssertFalse(earlySaves[0].contains(#""actual_weight":"225""#), "the undone row is not sent: \(earlySaves[0])")
            XCTAssertTrue(earlySaves[0].contains(#""setLogs":[]"#), "no row at all: \(earlySaves[0])")
            XCTAssertTrue(earlySaves[0].contains(#""removedSets":[{"#), "the planned row's undo records its removal; the server's delete of a row it never saw is a no-op")

            // After: the first save carried the row; the undo's save deletes it.
            let late = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            late.model.tapMic()
            await VoiceSupport.waitUntil { late.model.voice.isApplied }
            await late.model.flushEdits()
            late.model.undoSpoken()
            await late.model.flushEdits()
            let lateSaves = late.transport.bodies(action: "save")
            XCTAssertEqual(lateSaves.count, 2)
            XCTAssertTrue(lateSaves[0].contains(#""actual_weight":"225""#))
            XCTAssertTrue(lateSaves[1].contains(#""removedSets":[{"#), "the delete: \(lateSaves[1])")
            XCTAssertTrue(lateSaves[1].contains(#""setNumber":1"#), lateSaves[1])
            XCTAssertTrue(lateSaves[1].contains(#""setLogs":[]"#), lateSaves[1])
            XCTAssertFalse(lateSaves[1].contains(#""actual_weight":"225""#))
        }
    }

    func testTheUndoOfferEndsOnATypedEditTheNextSetTheNextTapOrFifteenSeconds() async {
        await VoiceSupport.withVoiceEnabled {
            // A typed edit to the row it wrote.
            let edited = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            edited.model.tapMic()
            await VoiceSupport.waitUntil { edited.model.voice.isApplied }
            edited.model.setValue("230", .weight, at: press1)
            XCTAssertEqual(edited.model.voice, .idle)

            // The next spoken set replaces the offer with its own.
            let next = await VoiceSupport.make(script: ["fixture press 225 for 5", "fixture press 235 for 3"])
            next.model.tapMic()
            await VoiceSupport.waitUntil { next.model.voice.isApplied }
            next.model.tapMic()
            await VoiceSupport.waitUntil { next.model.voice.appliedLabel == "Logged Fixture Press · 235 lb × 3" }
            XCTAssertEqual(next.model.voice.applied?.keys, [press2])

            // The next mic tap, with nothing scripted, listens.
            let tapped = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            tapped.model.tapMic()
            await VoiceSupport.waitUntil { tapped.model.voice.isApplied }
            tapped.model.tapMic()
            await VoiceSupport.waitUntil { tapped.model.voice.isListening }
            XCTAssertFalse(tapped.model.voice.isApplied)

            // Fifteen seconds.
            let timed = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            timed.model.tapMic()
            await VoiceSupport.waitUntil { timed.model.voice.isApplied }
            // (The autosave debounce sleeps on this clock, which jumps 0.8 s per
            // sleep, so the boundary is straddled rather than touched.)
            timed.clock.advance(by: 14.0)
            timed.model.voiceTick()
            XCTAssertTrue(timed.model.voice.isApplied)
            timed.clock.advance(by: 1.1)
            timed.model.voiceTick()
            XCTAssertEqual(timed.model.voice, .idle)
            XCTAssertEqual(timed.model.set(at: press1)?.actualWeight, "225", "the set stays; only the offer ends")
        }
    }

    // MARK: - End of utterance (step-wise fake, test clock)

    func testFiveSecondsOfNothingEndsTheListen() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice == .listening(partial: "", heardSpeech: false) }
            XCTAssertEqual(model.voiceListenCount, 1)
            made.clock.advance(by: 4.9)
            model.voiceTick()
            XCTAssertTrue(model.voice.isListening)
            made.clock.advance(by: 0.2)
            model.voiceTick()
            XCTAssertEqual(model.voice, .failed(.noSpeech, reason: TrackerModel.noSpeechReason))
            await VoiceSupport.waitUntil { made.fake.abortCount == 1 }
            XCTAssertFalse(made.fake.isListening, "the microphone is off")
            XCTAssertEqual(made.journal.load().entries.last?.endReason, .noSpeech)
            XCTAssertEqual(model.voiceFailCount, 1)
        }
    }

    func testTheSilenceWindowFollowsWhatWasHeard() async {
        await VoiceSupport.withVoiceEnabled {
            // Two values already: 1.0 s.
            let quick = await VoiceSupport.make()
            quick.model.tapMic()
            await VoiceSupport.waitUntil { quick.model.voice.isListening }
            quick.fake.emit(.partial("fixture press 225 for 5"))
            await VoiceSupport.waitUntil { quick.model.voice == .listening(partial: "fixture press 225 for 5", heardSpeech: true) }
            quick.clock.advance(by: 0.9)
            quick.model.voiceTick()
            XCTAssertTrue(quick.model.voice.isListening)
            quick.clock.advance(by: 0.2)
            quick.model.voiceTick()
            XCTAssertTrue(quick.model.voice.isFinishing)
            XCTAssertEqual(quick.fake.finishCount, 1)
            await VoiceSupport.waitUntil { quick.model.voice.isApplied }
            XCTAssertEqual(quick.model.set(at: press1)?.actualWeight, "225")
            let entry = quick.journal.load().entries.last
            XCTAssertEqual(entry?.endReason, .silence)
            XCTAssertNotNil(entry?.tapToListening)
            XCTAssertNotNil(entry?.lastPartialToFinal)
            XCTAssertLessThanOrEqual(entry?.finalToApplied ?? 1, 0.1, "the final to the row, at most 100 ms")

            // Ends in a connective: 2.0 s.
            let open = await VoiceSupport.make()
            open.model.tapMic()
            await VoiceSupport.waitUntil { open.model.voice.isListening }
            open.fake.emit(.partial("fixture press 225 for"))
            await VoiceSupport.waitUntil { open.model.voice == .listening(partial: "fixture press 225 for", heardSpeech: true) }
            open.clock.advance(by: 1.9)
            open.model.voiceTick()
            XCTAssertTrue(open.model.voice.isListening, "more is coming after 'for'")
            open.clock.advance(by: 0.2)
            open.model.voiceTick()
            XCTAssertTrue(open.model.voice.isFinishing)

            // A name with no values: 2.0 s; one value: 1.5 s.
            let context = open.model.voiceContext()
            XCTAssertEqual(TrackerModel.window(for: "fixture press", context: context), 2.0)
            XCTAssertEqual(TrackerModel.window(for: "fixture press 225", context: context), 1.5)
            XCTAssertEqual(TrackerModel.window(for: "fixture press 225 for 5", context: context), 1.0)
            XCTAssertEqual(TrackerModel.window(for: "5 reps 8 reps", context: context), 1.5, "invalid so far")
            XCTAssertEqual(TrackerModel.window(for: "", context: context), 1.5)
        }
    }

    func testEightSecondsIsTheCapEvenWhileSpeechContinues() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isListening }
            for _ in 0..<7 {
                made.fake.emit(.partial("fixture press 225 for"))
                try? await Task.sleep(for: .milliseconds(20))
                made.clock.advance(by: 1.0)
                model.voiceTick()
                XCTAssertTrue(model.voice.isListening, "each partial resets the window")
            }
            made.fake.emit(.partial("fixture press 225 for"))
            try? await Task.sleep(for: .milliseconds(20))
            made.clock.advance(by: 1.1)
            model.voiceTick()
            XCTAssertTrue(model.voice.isFinishing, "8 s since .listening")
            await VoiceSupport.waitUntil { made.journal.load().entries.count == 1 }
            XCTAssertEqual(made.journal.load().entries.last?.endReason, .cap)
        }
    }

    func testASecondTapFinishesAndApplies() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isListening }
            made.fake.emit(.partial("fixture press 225 for 5"))
            await VoiceSupport.waitUntil { model.voice.isListening && model.voice != .listening(partial: "", heardSpeech: false) }
            model.tapMic()
            XCTAssertTrue(model.voice.isFinishing)
            await VoiceSupport.waitUntil { model.voice.isApplied }
            XCTAssertEqual(made.journal.load().entries.last?.endReason, .tap)
            XCTAssertEqual(made.fake.finishCount, 1)
        }
    }

    func testTheFinalDeadlineParsesTheLastPartial() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            let model = made.model
            made.fake.finishDeliversFinal = false
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isListening }
            made.fake.emit(.partial("fixture press 225 for 5"))
            await VoiceSupport.waitUntil { model.voice == .listening(partial: "fixture press 225 for 5", heardSpeech: true) }
            made.clock.advance(by: 1.0)
            model.voiceTick()
            XCTAssertTrue(model.voice.isFinishing)
            made.clock.advance(by: 1.4)
            model.voiceTick()
            XCTAssertTrue(model.voice.isFinishing, "the final still has time")
            made.clock.advance(by: 0.2)
            model.voiceTick()
            XCTAssertTrue(model.voice.isApplied, "the last partial was the utterance")
            XCTAssertEqual(model.set(at: press1)?.actualWeight, "225")
            let entry = made.journal.load().entries.last
            XCTAssertEqual(entry?.endReason, .deadline)
            XCTAssertEqual(entry?.alternatives, ["fixture press 225 for 5"])
            XCTAssertEqual(entry?.lastPartialToFinal ?? 0, 2.6, accuracy: 0.01, "the window (1.0), then the deadline (1.4 + 0.2)")
            XCTAssertLessThanOrEqual(entry?.finalToApplied ?? 1, 0.1)
            await VoiceSupport.waitUntil { made.fake.abortCount == 1 }
        }
    }

    func testBackgroundAndTheFinishGateCancelWithNothingApplied() async {
        await VoiceSupport.withVoiceEnabled {
            let away = await VoiceSupport.make()
            away.model.tapMic()
            await VoiceSupport.waitUntil { away.model.voice.isListening }
            away.fake.emit(.partial("fixture press 225 for 5"))
            await VoiceSupport.waitUntil { away.model.voice == .listening(partial: "fixture press 225 for 5", heardSpeech: true) }
            away.model.cancelVoice()
            XCTAssertEqual(away.model.voice, .idle)
            XCTAssertEqual(away.model.set(at: press1)?.actualWeight, "")
            await VoiceSupport.waitUntil { away.fake.abortCount == 1 }
            XCTAssertEqual(away.journal.load().entries.last?.endReason, .cancelled)
            // A final that arrives after the cancel changes nothing.
            away.fake.emit(.final(["fixture press 225 for 5"]))
            try? await Task.sleep(for: .milliseconds(50))
            XCTAssertEqual(away.model.set(at: press1)?.actualWeight, "")

            let gated = await VoiceSupport.make()
            gated.model.tapMic()
            await VoiceSupport.waitUntil { gated.model.voice.isListening }
            await gated.model.requestFinish()
            XCTAssertEqual(gated.model.gate, .needsConfirm(count: 2))
            XCTAssertEqual(gated.model.voice, .idle)
            XCTAssertTrue(gated.model.voiceDisabled, "the mic is disabled under the gate")
        }
    }

    // MARK: - Review follow-ups

    func testSpeechDetectedWithoutATranscriptRestartsTheNoSpeechBudget() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isListening }
            made.clock.advance(by: 3)
            model.voiceTick()
            made.fake.emit(.partial(""))
            await VoiceSupport.waitUntil { model.voice == .listening(partial: "", heardSpeech: true) }
            made.clock.advance(by: 1.6)
            model.voiceTick()
            XCTAssertTrue(model.voice.isListening, "detection is not a transcript: no silence window yet")
            made.clock.advance(by: 3.3)
            model.voiceTick()
            XCTAssertTrue(model.voice.isListening, "4.9 s since detection")
            made.clock.advance(by: 0.2)
            model.voiceTick()
            XCTAssertEqual(model.voice, .failed(.noSpeech, reason: TrackerModel.noSpeechReason), "5 s since detection, nothing recognised")
        }
    }

    func testAMicrophoneThatNeverComesUpIsBoundedAndASecondTapIsNotUndoneByALateListening() async {
        await VoiceSupport.withVoiceEnabled {
            let slow = await VoiceSupport.make()
            slow.fake.yieldsListening = false
            slow.model.tapMic()
            await VoiceSupport.waitUntil { slow.model.voice == .activating }
            slow.clock.advance(by: 7.9)
            slow.model.voiceTick()
            XCTAssertEqual(slow.model.voice, .activating)
            slow.clock.advance(by: 0.2)
            slow.model.voiceTick()
            XCTAssertEqual(slow.model.voice, .failed(.noInput, reason: TrackerModel.noMicrophoneReason))
            XCTAssertEqual(slow.journal.load().entries.last?.endReason, .failed)

            let tapped = await VoiceSupport.make()
            tapped.fake.yieldsListening = false
            // The recognizer takes its time answering the finish (a real one does).
            tapped.fake.finishDeliversFinal = false
            tapped.model.tapMic()
            await VoiceSupport.waitUntil { tapped.model.voice == .activating }
            tapped.model.tapMic()
            XCTAssertEqual(tapped.model.voice, .finishing(partial: ""))
            XCTAssertEqual(tapped.fake.finishCount, 1)
            tapped.fake.emit(.listening)
            try? await Task.sleep(for: .milliseconds(50))
            XCTAssertEqual(tapped.model.voice, .finishing(partial: ""), "the user already ended it")
            XCTAssertEqual(tapped.model.voiceListenCount, 0, "no listen haptic after the end either")
        }
    }

    func testAFinishTheRecognizerAnswersWithNothingKeepsWhyItWasFinished() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.model.voice.isListening }
            made.model.tapMic()
            XCTAssertTrue(made.model.voice.isFinishing)
            await VoiceSupport.waitUntil { made.model.voice == .failed(.noSpeech, reason: TrackerModel.noSpeechReason) }
            XCTAssertEqual(made.journal.load().entries.last?.endReason, .tap, "the tap, not the recognizer's answer")
        }
    }

    func testTheFinalToRowHopIsSynchronousAndQuick() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make()
            made.fake.finishDeliversFinal = false
            made.model.tapMic()
            await VoiceSupport.waitUntil { made.model.voice.isListening }
            made.fake.emit(.partial("fixture press 225 for 5"))
            await VoiceSupport.waitUntil { made.model.voice == .listening(partial: "fixture press 225 for 5", heardSpeech: true) }
            made.clock.advance(by: 1.0)
            made.model.voiceTick()
            made.clock.advance(by: 1.5)
            // The deadline tick parses the last partial and writes the row in
            // one synchronous pass: wall-clock it (the test clock cannot).
            let started = Date()
            made.model.voiceTick()
            let elapsed = Date().timeIntervalSince(started)
            XCTAssertTrue(made.model.voice.isApplied)
            XCTAssertLessThan(elapsed, 0.1, "parse + apply took \(elapsed) s")
        }
    }

    func testUndoLeavesARestALaterTypedSetStarted() async {
        await VoiceSupport.withVoiceEnabled {
            let made = await VoiceSupport.make(script: ["fixture press 225 for 5"])
            let model = made.model
            model.tapMic()
            await VoiceSupport.waitUntil { model.voice.isApplied }
            XCTAssertTrue(model.rest.isRunning)
            made.clock.advance(by: 20)
            // A set typed on another row keeps the offer (the key is not the
            // apply's) and starts its own rest.
            model.setValue("5", .reps, at: press2)
            XCTAssertTrue(model.voice.isApplied)
            let later = model.rest
            model.undoSpoken()
            XCTAssertEqual(model.rest, later, "the later rest is not the apply's: it stays")
            XCTAssertEqual(model.set(at: press1)?.actualWeight, "", "the spoken row still reverts")
        }
    }
}
