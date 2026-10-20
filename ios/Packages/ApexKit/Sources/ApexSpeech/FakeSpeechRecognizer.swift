import Foundation

/// An in-memory recognizer: the unit tests', the simulator's and the
/// `-apexMockSpeech` smoke's. Two ways to drive it.
///
/// **Scripted**: give it utterances and each `listen` plays the next one at
/// once, in the adapter's sequence — `.listening`, the empty partial the
/// recognizer sends when it first detects speech, the words as growing
/// partials (each partial is the whole utterance so far, as the real
/// hypotheses are), then `.final([utterance])`.
///
/// **Step-wise**: with the script empty (or used up), `listen` yields
/// `.listening` and waits for the test to `emit` partials, `emitFinal()` or
/// `fail(_:)`, so an end-of-utterance policy can be exercised over `TestClock`
/// one event at a time. `finish()` delivers the last partial as the final —
/// or `.failed(.noSpeech)` when nothing was heard, as the adapter does —
/// unless `finishDeliversFinal` is off, which is how a test reaches the
/// "final never arrived" deadline path.
///
/// Like the adapter, a second `listen` or a cancelled consumer aborts the
/// utterance before it. A request on an undecided recognizer grants — both
/// sheets' "Allow" — unless `grantOnRequest` is false.
public nonisolated final class FakeSpeechRecognizer: SpeechRecognizing, @unchecked Sendable {
    private let lock = NSLock()
    private var _authorization: SpeechAuthorization
    private var _availability: SpeechAvailability
    private var _script: [String]
    private let grantOnRequest: Bool
    private var _finishDeliversFinal = true
    private var _authorizationDelay: Duration = .zero
    private var _yieldsListening = true
    private var _requests = 0
    private var _biases: [[String]] = []
    private var _finishes = 0
    private var _aborts = 0
    private var current: Utterance?

    public init(
        authorization: SpeechAuthorization = .notDetermined,
        availability: SpeechAvailability = .available(locale: "en-US"),
        script: [String] = [],
        grantOnRequest: Bool = true
    ) {
        _authorization = authorization
        _availability = availability
        _script = script
        self.grantOnRequest = grantOnRequest
    }

    /// How many times `requestAuthorization()` was called.
    public var requestCount: Int { lock.withLock { _requests } }
    /// The names each `listen(bias:)` was given, in order.
    public var biases: [[String]] { lock.withLock { _biases } }
    /// How many utterances the consumer ended with `finish()`.
    public var finishCount: Int { lock.withLock { _finishes } }
    /// How many utterances were aborted: a cancelled consumer or a later `listen`.
    public var abortCount: Int { lock.withLock { _aborts } }
    /// Whether an utterance is live: started, and no final or failure yet.
    public var isListening: Bool { lock.withLock { current != nil } }
    /// Off, `finish()` only counts; the test delivers (or withholds) the final.
    public var finishDeliversFinal: Bool {
        get { lock.withLock { _finishDeliversFinal } }
        set { lock.withLock { _finishDeliversFinal = newValue } }
    }
    /// How long `requestAuthorization()` takes to answer — the sheets are up
    /// that long, and a test can act while they are.
    public var authorizationDelay: Duration {
        get { lock.withLock { _authorizationDelay } }
        set { lock.withLock { _authorizationDelay = newValue } }
    }
    /// Off, `listen` yields nothing until the test emits `.listening` itself —
    /// the microphone taking its time to come up.
    public var yieldsListening: Bool {
        get { lock.withLock { _yieldsListening } }
        set { lock.withLock { _yieldsListening = newValue } }
    }

    public func setAuthorization(_ value: SpeechAuthorization) { lock.withLock { _authorization = value } }
    public func setAvailability(_ value: SpeechAvailability) { lock.withLock { _availability = value } }

    public func availability() -> SpeechAvailability { lock.withLock { _availability } }
    public func audioRoute() -> String { "Fake Microphone → Fake Speaker" }
    public func authorization() -> SpeechAuthorization { lock.withLock { _authorization } }

    public func requestAuthorization() async -> SpeechAuthorization {
        let delay = lock.withLock { _authorizationDelay }
        if delay > .zero { try? await Task.sleep(for: delay) }
        return lock.withLock {
            _requests += 1
            if _authorization == .notDetermined { _authorization = grantOnRequest ? .authorized : .denied }
            return _authorization
        }
    }

    public func listen(bias: SpeechBias) -> SpeechUtterance {
        let (events, continuation) = AsyncStream<SpeechEvent>.makeStream()
        let utterance = Utterance(continuation: continuation)
        let (previous, scripted): (Utterance?, String?) = lock.withLock {
            _biases.append(bias.names)
            defer { current = utterance }
            return (current, _script.isEmpty ? nil : _script.removeFirst())
        }
        // Starting another aborts the previous — if it was still open.
        if let previous, previous.yield(.failed(.cancelled)) { lock.withLock { _aborts += 1 } }
        continuation.onTermination = { [weak self, weak utterance] reason in
            // The consumer stopped reading before the end: microphone off, no final.
            guard case .cancelled = reason, let self, let utterance, utterance.close() else { return }
            self.lock.withLock {
                _aborts += 1
                if current === utterance { current = nil }
            }
        }
        if lock.withLock({ _yieldsListening }) { utterance.yield(.listening) }
        if let scripted {
            utterance.yield(.partial(""))
            var heard: [Substring] = []
            for word in scripted.split(separator: " ") {
                heard.append(word)
                utterance.yield(.partial(heard.joined(separator: " ")))
            }
            utterance.yield(.final([scripted]))
            lock.withLock { if current === utterance { current = nil } }
        }
        return SpeechUtterance(events: events) { [weak self, weak utterance] in
            guard let self, let utterance, utterance.markFinishing() else { return }
            let delivers: Bool = lock.withLock {
                _finishes += 1
                return _finishDeliversFinal
            }
            guard delivers, utterance.yield(Self.ending(for: utterance.text)) else { return }
            lock.withLock { if current === utterance { current = nil } }
        }
    }

    /// Nothing heard is `.failed(.noSpeech)`, as the adapter reports a
    /// recognizer that finishes with no result; never an empty final.
    private static func ending(for text: String) -> SpeechEvent {
        text.isEmpty ? .failed(.noSpeech) : .final([text])
    }

    // MARK: - Step-wise drive

    /// Feeds the live utterance one event. A `.partial` grows the transcript
    /// `emitFinal()` delivers; a `.final` or `.failed` ends it. False, and
    /// nothing happens, without a live utterance.
    @discardableResult
    public func emit(_ event: SpeechEvent) -> Bool {
        guard let utterance = lock.withLock({ current }), utterance.yield(event) else { return false }
        switch event {
        case .final, .failed: lock.withLock { if current === utterance { current = nil } }
        case .listening, .partial: break
        }
        return true
    }

    /// The final is the last partial, the way the recognizer's final repeats
    /// its last hypothesis; with nothing heard it is `.failed(.noSpeech)`.
    public func emitFinal() {
        guard let utterance = lock.withLock({ current }) else { return }
        emit(Self.ending(for: utterance.text))
    }

    public func fail(_ failure: SpeechFailure) { emit(.failed(failure)) }

    /// One live utterance's stream and transcript. Open until a `.final` or
    /// `.failed` is yielded or the consumer goes away; nothing is yielded after.
    private final class Utterance: @unchecked Sendable {
        private let lock = NSLock()
        private let continuation: AsyncStream<SpeechEvent>.Continuation
        private var lastPartial = ""
        private var open = true
        private var finishing = false

        init(continuation: AsyncStream<SpeechEvent>.Continuation) {
            self.continuation = continuation
        }

        var text: String { lock.withLock { lastPartial } }

        /// Yields while open; a `.final` or `.failed` closes the stream.
        /// False when the utterance was already over.
        @discardableResult
        func yield(_ event: SpeechEvent) -> Bool {
            lock.withLock {
                guard open else { return false }
                if case .partial(let text) = event { lastPartial = text }
                continuation.yield(event)
                switch event {
                case .final, .failed:
                    open = false
                    continuation.finish()
                case .listening, .partial:
                    break
                }
                return true
            }
        }

        /// The first `finish()` on an open utterance; later ones are no-ops.
        func markFinishing() -> Bool {
            lock.withLock {
                guard open, !finishing else { return false }
                finishing = true
                return true
            }
        }

        /// The consumer is gone: close without yielding. False if already over.
        func close() -> Bool {
            lock.withLock {
                guard open else { return false }
                open = false
                continuation.finish()
                return true
            }
        }
    }
}
