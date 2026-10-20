import Foundation

/// Where Apex stands with speech recognition and the microphone. Two system
/// sheets gate a listen (Speech, then the microphone); the tracker treats them
/// as one answer and asks on the first mic tap, never at launch (W17, D-059).
public nonisolated enum SpeechAuthorization: Sendable, Equatable {
    /// No recognizer for the user's language on this device.
    case unavailable
    /// Never asked.
    case notDetermined
    /// Either sheet refused, or recognition is restricted; fixed in Settings.
    case denied
    case authorized
}

/// Whether a listen can start at all. Live: the answer changes at runtime (the
/// on-device assets download, the Dictation toggle flips), so the tracker asks
/// each time it decides whether to show the mic.
public nonisolated enum SpeechAvailability: Sendable, Equatable {
    case unavailable(reason: String)
    case available(locale: String)
}

/// Why an utterance ended without a final transcript.
public nonisolated enum SpeechFailure: Sendable, Equatable {
    /// Speech or the microphone was refused (kAFAssistantErrorDomain 1700).
    case notAuthorized
    /// Siri and Dictation are off in Settings (kLSRErrorDomain 201).
    case dictationDisabled
    /// The on-device language assets are not installed (kLSRErrorDomain 102).
    case assetsMissing
    /// Nothing was said (kAFAssistantErrorDomain 1110).
    case noSpeech
    /// The audio input has no usable format: no microphone route.
    case noInput
    /// The recognition service failed or went away (1101, 1107, anything unmapped).
    case serviceFailed
    /// A call, a lost route or an audio configuration change ended the listen;
    /// never resumed on its own.
    case interrupted
    /// Replaced by a later `listen`, or cancelled by the system.
    case cancelled
}

/// What one utterance emits, in order: `.listening` once the microphone is
/// live, `.partial` as the transcript grows (each one is the whole utterance so
/// far), then exactly one of `.final` (alternatives, best first) or `.failed`.
public nonisolated enum SpeechEvent: Sendable, Equatable {
    case listening
    case partial(String)
    case final([String])
    case failed(SpeechFailure)
}

/// Names to bias recognition toward — today's exercises, the library. A custom
/// language model slots in here later (M3).
public nonisolated struct SpeechBias: Sendable {
    public var names: [String]

    public init(names: [String]) {
        self.names = names
    }
}

/// One utterance. `events` ends after `.final` or `.failed`. Cancelling the
/// consumer aborts (microphone off, no final). `finish()` ends the audio and
/// lets the final arrive.
public nonisolated struct SpeechUtterance: Sendable {
    public let events: AsyncStream<SpeechEvent>
    public let finish: @Sendable () -> Void

    public init(events: AsyncStream<SpeechEvent>, finish: @escaping @Sendable () -> Void) {
        self.events = events
        self.finish = finish
    }
}

/// What the tracker needs from speech recognition. The app injects
/// `SFSpeechRecognizerAdapter` on a phone; the simulator, the unit tests and
/// the XCUITest smoke get `FakeSpeechRecognizer`; previews and the services
/// default get `NoSpeechRecognizer`.
public nonisolated protocol SpeechRecognizing: Sendable {
    /// Live: the answer can change while the tracker is open.
    func availability() -> SpeechAvailability
    func authorization() -> SpeechAuthorization
    /// Both sheets, Speech then the microphone; a denial of either is `.denied`.
    func requestAuthorization() async -> SpeechAuthorization
    /// At most one utterance at a time; starting another aborts the previous.
    func listen(bias: SpeechBias) -> SpeechUtterance
}

/// No recognizer: the services default and the previews. The tracker shows no
/// microphone for `.unavailable`, so `listen` is never reached; if it is, the
/// utterance fails at once rather than hanging.
public nonisolated struct NoSpeechRecognizer: SpeechRecognizing {
    public init() {}

    public func availability() -> SpeechAvailability { .unavailable(reason: "No speech recognizer") }
    public func authorization() -> SpeechAuthorization { .unavailable }
    public func requestAuthorization() async -> SpeechAuthorization { .unavailable }

    public func listen(bias: SpeechBias) -> SpeechUtterance {
        let (events, continuation) = AsyncStream<SpeechEvent>.makeStream()
        continuation.yield(.failed(.serviceFailed))
        continuation.finish()
        return SpeechUtterance(events: events, finish: {})
    }
}
