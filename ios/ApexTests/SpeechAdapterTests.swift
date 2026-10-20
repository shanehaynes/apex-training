import ApexSpeech
import XCTest

/// W17 PR-H: the speech surface over the fake — the event order every
/// consumer relies on, the ways an utterance ends, and what the fake records
/// for the tracker's tests — plus the adapter's two pure rules. The adapter's
/// microphone paths need a phone; their pins are in the PR body.
final class SpeechAdapterTests: XCTestCase {
    private func collect(_ utterance: SpeechUtterance) async -> [SpeechEvent] {
        var events: [SpeechEvent] = []
        for await event in utterance.events { events.append(event) }
        return events
    }

    private func assertEvents(
        _ utterance: SpeechUtterance, _ expected: [SpeechEvent], _ message: String = "",
        file: StaticString = #filePath, line: UInt = #line
    ) async {
        let events = await collect(utterance)
        XCTAssertEqual(events, expected, message, file: file, line: line)
    }

    // MARK: - Scripted drive

    func testAScriptedUtteranceListensThenGrowsThenFinals() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized, script: ["bench 225 for 5", "again"])
        await assertEvents(fake.listen(bias: SpeechBias(names: ["Bench Press", "Back Squat"])), [
            .listening,
            .partial(""),  // speech detected, no hypothesis yet — the adapter's first partial
            .partial("bench"), .partial("bench 225"), .partial("bench 225 for"), .partial("bench 225 for 5"),
            .final(["bench 225 for 5"]),
        ])
        XCTAssertFalse(fake.isListening, "a final ends the utterance")

        await assertEvents(fake.listen(bias: SpeechBias(names: [])), [.listening, .partial(""), .partial("again"), .final(["again"])])
        XCTAssertEqual(fake.biases[0], ["Bench Press", "Back Squat"], "the names passed to listen(bias:)")
        XCTAssertEqual(fake.biases, [["Bench Press", "Back Squat"], []])

        let third = fake.listen(bias: SpeechBias(names: []))
        XCTAssertTrue(fake.isListening, "the script is used up: step-wise from here")
        fake.fail(.noSpeech)
        await assertEvents(third, [.listening, .failed(.noSpeech)])
    }

    // MARK: - Step-wise drive

    func testFinishYieldsTheLastPartialAsTheFinal() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized)
        let utterance = fake.listen(bias: SpeechBias(names: ["Plank"]))
        fake.emit(.partial("plank"))
        fake.emit(.partial("plank 45 seconds"))
        utterance.finish()
        await assertEvents(utterance, [.listening, .partial("plank"), .partial("plank 45 seconds"), .final(["plank 45 seconds"])])
        XCTAssertEqual(fake.finishCount, 1)
        XCTAssertFalse(fake.isListening)

        utterance.finish()
        XCTAssertEqual(fake.finishCount, 1, "a second finish is a no-op")
        XCTAssertFalse(fake.emit(.partial("too late")), "nothing after the final")
    }

    func testNothingHeardIsNoSpeechNeverAnEmptyFinal() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized)
        let finished = fake.listen(bias: SpeechBias(names: []))
        finished.finish()
        await assertEvents(finished, [.listening, .failed(.noSpeech)], "finish() with nothing heard")
        XCTAssertEqual(fake.finishCount, 1)

        let emitted = fake.listen(bias: SpeechBias(names: []))
        fake.emit(.partial(""))
        fake.emitFinal()
        await assertEvents(emitted, [.listening, .partial(""), .failed(.noSpeech)], "emitFinal() with only the detection partial")
        XCTAssertFalse(fake.isListening)
    }

    func testEmitFinalRepeatsTheLastPartialAndAFailureEndsTheStream() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized)
        let applied = fake.listen(bias: SpeechBias(names: []))
        fake.emit(.partial("squat"))
        fake.emit(.partial("squat 5 at 225"))
        fake.emitFinal()
        await assertEvents(applied, [.listening, .partial("squat"), .partial("squat 5 at 225"), .final(["squat 5 at 225"])])

        let interrupted = fake.listen(bias: SpeechBias(names: []))
        fake.emit(.partial("bench"))
        fake.fail(.interrupted)
        fake.emit(.partial("ignored"))
        await assertEvents(interrupted, [.listening, .partial("bench"), .failed(.interrupted)])
        XCTAssertFalse(fake.isListening)
        XCTAssertEqual(fake.finishCount, 0, "neither ended by finish()")
    }

    func testFinishCanWithholdTheFinalForTheDeadlinePath() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized)
        fake.finishDeliversFinal = false
        let utterance = fake.listen(bias: SpeechBias(names: []))
        fake.emit(.partial("bench 225"))
        utterance.finish()
        XCTAssertEqual(fake.finishCount, 1)
        XCTAssertTrue(fake.isListening, "the final is still owed")
        fake.emitFinal()
        await assertEvents(utterance, [.listening, .partial("bench 225"), .final(["bench 225"])])
        XCTAssertFalse(fake.isListening)
    }

    // MARK: - Aborts

    func testCancellingTheConsumerEndsTheStreamWithNoFinal() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized)
        let utterance = fake.listen(bias: SpeechBias(names: []))
        // A Sendable signal (XCTestExpectation is not): the consumer has seen
        // .listening and is parked on the next event when we cancel it.
        let (heardListening, signal) = AsyncStream<Void>.makeStream()
        let consumer = Task { () -> [SpeechEvent] in
            var events: [SpeechEvent] = []
            for await event in utterance.events {
                events.append(event)
                if event == .listening { signal.yield(()) }
            }
            return events
        }
        for await _ in heardListening { break }

        consumer.cancel()
        let events = await consumer.value
        XCTAssertEqual(events, [.listening], "the loop ends; no final, no failure")
        XCTAssertEqual(fake.abortCount, 1, "the fake saw the consumer go: microphone off")
        XCTAssertFalse(fake.isListening)
        fake.emitFinal()
        XCTAssertEqual(fake.finishCount, 0, "nothing left to deliver to")
    }

    func testASecondListenAbortsTheFirst() async {
        let fake = FakeSpeechRecognizer(authorization: .authorized)
        let first = fake.listen(bias: SpeechBias(names: ["A"]))
        fake.emit(.partial("bench"))
        let second = fake.listen(bias: SpeechBias(names: ["B"]))
        await assertEvents(first, [.listening, .partial("bench"), .failed(.cancelled)])
        XCTAssertEqual(fake.abortCount, 1)

        fake.emit(.partial("squat"))
        fake.emitFinal()
        await assertEvents(second, [.listening, .partial("squat"), .final(["squat"])])
        XCTAssertEqual(fake.biases, [["A"], ["B"]])
    }

    // MARK: - Authorization and availability

    func testAuthorizationIsAskedOnceAndTheAnswerStays() async {
        let fake = FakeSpeechRecognizer()
        XCTAssertEqual(fake.authorization(), .notDetermined)
        XCTAssertEqual(fake.availability(), .available(locale: "en-US"))
        let granted = await fake.requestAuthorization()
        XCTAssertEqual(granted, .authorized)
        XCTAssertEqual(fake.requestCount, 1)
        XCTAssertEqual(fake.authorization(), .authorized)

        let refused = FakeSpeechRecognizer(grantOnRequest: false)
        let firstAnswer = await refused.requestAuthorization()
        let secondAnswer = await refused.requestAuthorization()
        XCTAssertEqual(firstAnswer, .denied)
        XCTAssertEqual(secondAnswer, .denied, "a refusal is remembered, not re-asked")
        XCTAssertEqual(refused.requestCount, 2)

        let unavailable = FakeSpeechRecognizer(authorization: .unavailable, availability: .unavailable(reason: "test"))
        let noAnswer = await unavailable.requestAuthorization()
        XCTAssertEqual(noAnswer, .unavailable)
        XCTAssertEqual(unavailable.availability(), .unavailable(reason: "test"))

        fake.setAuthorization(.denied)
        fake.setAvailability(.unavailable(reason: "Dictation off"))
        XCTAssertEqual(fake.authorization(), .denied)
        XCTAssertEqual(fake.availability(), .unavailable(reason: "Dictation off"))
    }

    func testNoRecognizerIsUnavailableAndFailsAListenAtOnce() async {
        let none = NoSpeechRecognizer()
        XCTAssertEqual(none.availability(), .unavailable(reason: "No speech recognizer"))
        XCTAssertEqual(none.authorization(), .unavailable)
        let answer = await none.requestAuthorization()
        XCTAssertEqual(answer, .unavailable)
        await assertEvents(none.listen(bias: SpeechBias(names: ["Bench Press"])), [.failed(.serviceFailed)])
    }

    // MARK: - The adapter's pure rules

    func testTheAdapterMapsTheRuntimeErrorsTheSDKDocuments() {
        func error(_ domain: String, _ code: Int) -> NSError { NSError(domain: domain, code: code) }
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kLSRErrorDomain", 201)), .dictationDisabled)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kLSRErrorDomain", 102)), .assetsMissing)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kLSRErrorDomain", 301)), .cancelled)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kAFAssistantErrorDomain", 1110)), .noSpeech)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kAFAssistantErrorDomain", 1101)), .serviceFailed)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kAFAssistantErrorDomain", 1107)), .serviceFailed)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kAFAssistantErrorDomain", 1700)), .notAuthorized)
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error("kAFAssistantErrorDomain", 201)), .serviceFailed, "a code from the wrong domain is not trusted")
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: error(NSURLErrorDomain, NSURLErrorNotConnectedToInternet)), .serviceFailed)
        let wrapped = NSError(domain: "SFSpeechErrorDomain", code: 1, userInfo: [NSUnderlyingErrorKey: error("kLSRErrorDomain", 201)])
        XCTAssertEqual(SFSpeechRecognizerAdapter.failure(for: wrapped), .dictationDisabled, "the reason underneath an SFSpeechErrorDomain wrapper")
    }

    func testTheAdapterPicksTheFirstEnglishLanguageElseEnUS() {
        XCTAssertEqual(SFSpeechRecognizerAdapter.locale(preferring: ["fr-FR", "en-GB", "en-US"]).identifier, "en-GB")
        XCTAssertEqual(SFSpeechRecognizerAdapter.locale(preferring: ["en-AU"]).identifier, "en-AU")
        XCTAssertEqual(SFSpeechRecognizerAdapter.locale(preferring: ["fr-FR", "de-DE"]).identifier, "en-US")
        XCTAssertEqual(SFSpeechRecognizerAdapter.locale(preferring: []).identifier, "en-US")
    }

    /// A construction smoke, nothing more: the real adapter on this simulator
    /// builds and answers both questions without a microphone or a sheet
    /// (nothing here may request authorization), and the two answers agree on
    /// whether a recognizer exists. What the simulator says about on-device
    /// support goes to the log, for the PR body; the device answer is a pin.
    func testTheAdapterConstructsAndAnswersWithoutASheet() {
        let adapter = SFSpeechRecognizerAdapter()
        let availability = adapter.availability()
        let authorization = adapter.authorization()
        print("SFSpeechRecognizerAdapter on this simulator: \(availability) · \(authorization)")
        switch (availability, authorization) {
        case (.unavailable(let reason), .unavailable):
            XCTAssertTrue(reason.hasPrefix("No speech recognizer"), "no recognizer at all: \(reason)")
        case (.unavailable(let reason), _):
            XCTAssertTrue(reason.hasPrefix("On-device recognition is not supported"), "a recognizer without on-device support: \(reason)")
        case (.available, .unavailable):
            XCTFail("a recognizer exists for availability() but not for authorization()")
        case (.available, _):
            break
        }
    }
}
