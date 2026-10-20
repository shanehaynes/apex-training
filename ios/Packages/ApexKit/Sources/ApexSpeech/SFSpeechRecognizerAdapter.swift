import AVFAudio
import Foundation
import Speech

/// Apple's Speech framework behind `SpeechRecognizing`, on the device only
/// (W17, D-059): every request sets `requiresOnDeviceRecognition`, so nothing
/// said leaves the phone, and there is no server fallback. One utterance at a
/// time. The audio session is activated on the tap and released on every exit,
/// so ducking and the orange indicator never outlive a listen; the recognizer
/// itself is created here, when the tracker opens, which costs nothing audible.
public nonisolated final class SFSpeechRecognizerAdapter: NSObject, SpeechRecognizing, SFSpeechRecognizerDelegate, @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer?
    private let localeIdentifier: String
    private let lock = NSLock()
    private var current: Utterance?

    public override init() {
        let locale = Self.locale(preferring: Locale.preferredLanguages)
        localeIdentifier = locale.identifier
        recognizer = SFSpeechRecognizer(locale: locale)
        super.init()
        recognizer?.delegate = self
    }

    /// The first preferred language with an `en` prefix, else en-US. Asking
    /// for no locale would fall back to the keyboard's dictation language,
    /// which need not be the one the exercise names are in.
    public static func locale(preferring languages: [String]) -> Locale {
        Locale(identifier: languages.first { $0.hasPrefix("en") } ?? "en-US")
    }

    /// A recognizer exists for the locale and it can run on the device. Not
    /// `isAvailable`: that is the network-era signal, and the runtime errors
    /// carry the real failures (`failure(for:)`).
    public func availability() -> SpeechAvailability {
        guard let recognizer else { return .unavailable(reason: "No speech recognizer for \(localeIdentifier)") }
        guard recognizer.supportsOnDeviceRecognition else {
            return .unavailable(reason: "On-device recognition is not supported for \(localeIdentifier)")
        }
        return .available(locale: localeIdentifier)
    }

    public func authorization() -> SpeechAuthorization {
        guard recognizer != nil else { return .unavailable }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .authorized
        case .denied: return .denied
        case .undetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    public func requestAuthorization() async -> SpeechAuthorization {
        guard recognizer != nil else { return .unavailable }
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        switch speech {
        case .authorized: break
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
        return await AVAudioApplication.requestRecordPermission() ? .authorized : .denied
    }

    public func listen(bias: SpeechBias) -> SpeechUtterance {
        let (events, continuation) = AsyncStream<SpeechEvent>.makeStream()
        let utterance = Utterance(continuation: continuation, bias: bias)
        utterance.onEnd = { [weak self, weak utterance] in
            guard let self, let utterance else { return }
            lock.withLock { if current === utterance { current = nil } }
        }
        let previous: Utterance? = lock.withLock {
            defer { current = utterance }
            return current
        }
        previous?.abort(.cancelled)
        continuation.onTermination = { [weak utterance] reason in
            // The consumer stopped reading: microphone off, nothing more to say.
            if case .cancelled = reason { utterance?.abort(nil) }
        }
        if let recognizer {
            utterance.start(recognizer: recognizer)
        } else {
            utterance.abort(.serviceFailed)
        }
        return SpeechUtterance(events: events) { [weak utterance] in utterance?.finish() }
    }

    // MARK: - SFSpeechRecognizerDelegate

    /// The service went away mid-listen: end it, never resume on its own.
    public func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        guard !available else { return }
        lock.withLock { current }?.abort(.serviceFailed)
    }

    // MARK: - Errors

    /// The failures a task's error carries (iOS 26.5 SDK, D-059's pins):
    /// `kLSRErrorDomain` 102 assets not installed, 201 Siri and Dictation off,
    /// 301 cancelled; `kAFAssistantErrorDomain` 1110 no speech, 1101 and 1107
    /// service invalidated or interrupted, 1700 not authorized. Anything else
    /// is a service failure.
    public static func failure(for error: any Error) -> SpeechFailure {
        let error = error as NSError
        switch (error.domain, error.code) {
        case ("kLSRErrorDomain", 102): return .assetsMissing
        case ("kLSRErrorDomain", 201): return .dictationDisabled
        case ("kLSRErrorDomain", 301): return .cancelled
        case ("kAFAssistantErrorDomain", 1110): return .noSpeech
        case ("kAFAssistantErrorDomain", 1101), ("kAFAssistantErrorDomain", 1107): return .serviceFailed
        case ("kAFAssistantErrorDomain", 1700): return .notAuthorized
        default: return .serviceFailed
        }
    }

    /// One listen. Owns the engine, the request and the task, and ends them in
    /// one order on every exit — task, tap, engine, session — so the session is
    /// never deactivated with I/O still running (that fails with `IsBusy`).
    private final class Utterance: NSObject, SFSpeechRecognitionTaskDelegate, @unchecked Sendable {
        private enum State { case running, finishing, ended }

        private let lock = NSLock()
        private var state = State.running
        private let continuation: AsyncStream<SpeechEvent>.Continuation
        private let bias: SpeechBias
        private let engine = AVAudioEngine()
        private let request = SFSpeechAudioBufferRecognitionRequest()
        private var task: SFSpeechRecognitionTask?
        private var tapInstalled = false
        private var sessionActive = false
        private var observing = false
        private var heardHypothesis = false
        /// Set once, before `start`: the adapter forgets the utterance.
        var onEnd: (@Sendable () -> Void)?

        init(continuation: AsyncStream<SpeechEvent>.Continuation, bias: SpeechBias) {
            self.continuation = continuation
            self.bias = bias
        }

        /// The per-tap sequence: session, input check, tap, engine, `.listening`,
        /// then the task. Nothing is touched before the tap, so ducking and the
        /// orange indicator start with the listen, not with the tracker.
        func start(recognizer: SFSpeechRecognizer) {
            let session = AVAudioSession.sharedInstance()
            do {
                // No HFP in v1: it would take Bluetooth input and drop music to
                // call quality. `.measurement` is the gym A/B knob; `.default`
                // is the other setting.
                try session.setCategory(
                    .playAndRecord, mode: .measurement, options: [.duckOthers, .allowBluetoothA2DP, .defaultToSpeaker]
                )
                try session.setActive(true)
            } catch {
                // Another audio activity owns the input (a call, Siri): this
                // listen is over; the next tap may well work.
                abort(.interrupted)
                return
            }
            lock.withLock { sessionActive = true }
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                abort(.noInput)
                return
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.append(buffer)
            }
            lock.withLock { tapInstalled = true }
            engine.prepare()
            do {
                try engine.start()
            } catch {
                abort(.noInput)
                return
            }
            observe(session)
            yield(.listening)
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            request.addsPunctuation = false
            request.contextualStrings = bias.names
            let task = recognizer.recognitionTask(with: request, delegate: self)
            let ended: Bool = lock.withLock {
                self.task = task
                return state == .ended
            }
            // Aborted between the tap and here (a cancelled consumer): the task
            // must not outlive the stream.
            if ended { task.cancel() }
        }

        /// The consumer's end of utterance: the microphone goes off now and the
        /// recognizer finishes over the audio it already has; its final arrives
        /// through the delegate and ends the stream.
        func finish() {
            let (proceed, task): (Bool, SFSpeechRecognitionTask?) = lock.withLock {
                guard state == .running else { return (false, nil) }
                state = .finishing
                return (true, self.task)
            }
            guard proceed else { return }
            request.endAudio()
            task?.finish()
            stopAudio()
        }

        /// Every other exit: a cancelled consumer (`nil`: nobody is reading), a
        /// later `listen`, an interruption, the service lost, an error.
        func abort(_ reason: SpeechFailure?) {
            end(with: reason.map(SpeechEvent.failed))
        }

        /// The one exit. Yields the final or the failure (if any), ends the
        /// stream, then tears down in order: task, tap, engine, session.
        private func end(with event: SpeechEvent?) {
            let (proceed, task): (Bool, SFSpeechRecognitionTask?) = lock.withLock {
                guard state != .ended else { return (false, nil) }
                state = .ended
                if let event { continuation.yield(event) }
                continuation.finish()
                defer { self.task = nil }
                return (true, self.task)
            }
            guard proceed else { return }
            task?.cancel()
            stopAudio()
            onEnd?()
        }

        /// Microphone off, in the order the session requires: the tap, the
        /// engine, then the session — `.notifyOthersOnDeactivation` un-ducks
        /// whatever was playing. Idempotent: `finish()` runs it early and the
        /// final's `end` runs it again.
        private func stopAudio() {
            let (tap, active, observing): (Bool, Bool, Bool) = lock.withLock {
                defer {
                    tapInstalled = false
                    sessionActive = false
                    self.observing = false
                }
                return (tapInstalled, sessionActive, self.observing)
            }
            if observing { NotificationCenter.default.removeObserver(self) }
            if tap { engine.inputNode.removeTap(onBus: 0) }
            if engine.isRunning { engine.stop() }
            if active { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        }

        private func yield(_ event: SpeechEvent) {
            lock.withLock {
                guard state != .ended else { return }
                continuation.yield(event)
            }
        }

        /// From the tap, on the audio thread. Buffers are only appended; a
        /// finishing or ended utterance takes no more audio.
        private func append(_ buffer: AVAudioPCMBuffer) {
            guard lock.withLock({ state == .running }) else { return }
            request.append(buffer)
        }

        // MARK: Interruptions — the listen ends, never resumes on its own

        private func observe(_ session: AVAudioSession) {
            let center = NotificationCenter.default
            center.addObserver(self, selector: #selector(sessionInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: session)
            center.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: session)
            center.addObserver(self, selector: #selector(engineConfigurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: engine)
            lock.withLock { observing = true }
        }

        /// A call, Siri, an alarm.
        @objc private func sessionInterrupted(_ note: Notification) {
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            abort(.interrupted)
        }

        /// The input route went away: headphones unplugged, AirPods off.
        @objc private func routeChanged(_ note: Notification) {
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            abort(.interrupted)
        }

        /// The engine's graph changed under us (a route or format change): the
        /// tap's format is stale, so the listen ends rather than guessing.
        @objc private func engineConfigurationChanged(_ note: Notification) {
            abort(.interrupted)
        }

        // MARK: SFSpeechRecognitionTaskDelegate — on the recognizer's queue (the main queue by default)

        /// Speech before any hypothesis: an empty partial, so a consumer's
        /// no-speech timer stops counting. The event vocabulary has no other
        /// way to say "heard something".
        func speechRecognitionDidDetectSpeech(_ task: SFSpeechRecognitionTask) {
            guard lock.withLock({ !heardHypothesis }) else { return }
            yield(.partial(""))
        }

        func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didHypothesizeTranscription transcription: SFTranscription) {
            lock.withLock { heardHypothesis = true }
            yield(.partial(transcription.formattedString))
        }

        /// The final: the best transcription first, then the other alternatives.
        func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishRecognition recognitionResult: SFSpeechRecognitionResult) {
            var alternatives = [recognitionResult.bestTranscription.formattedString]
            for transcription in recognitionResult.transcriptions where !alternatives.contains(transcription.formattedString) {
                alternatives.append(transcription.formattedString)
            }
            end(with: .final(alternatives))
        }

        /// After the final this is a no-op (the stream is already over). A
        /// success with no final means nothing was recognised; a failure
        /// carries the real reason.
        func speechRecognitionTask(_ task: SFSpeechRecognitionTask, didFinishSuccessfully successfully: Bool) {
            if successfully {
                end(with: .failed(.noSpeech))
            } else {
                end(with: .failed(task.error.map(SFSpeechRecognizerAdapter.failure(for:)) ?? .serviceFailed))
            }
        }

        func speechRecognitionTaskWasCancelled(_ task: SFSpeechRecognitionTask) {
            end(with: .failed(.cancelled))
        }
    }
}
